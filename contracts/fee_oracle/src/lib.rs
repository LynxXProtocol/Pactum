#![cfg_attr(not(any(feature = "std", test)), no_std)]

/// Fixed-point scaling factor: 1e6 (1,000,000).
/// Gain constants (Kp, Ki, Kd) are represented in fixed-point where 1_000_000 represents 1.0.
pub const SCALING_FACTOR: i128 = 1_000_000;

/// Minimum clamp bound for accumulated integral term to prevent negative windup.
pub const INTEGRAL_MIN: i128 = -1_000_000_000_000; // -1e12

/// Maximum clamp bound for accumulated integral term to prevent positive windup.
pub const INTEGRAL_MAX: i128 = 1_000_000_000_000; // 1e12

/// Configuration of PID controller gain parameters (scaled by SCALING_FACTOR).
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct PidGains {
    /// Proportional gain Kp (scaled by `SCALING_FACTOR`).
    pub kp: i128,
    /// Integral gain Ki (scaled by `SCALING_FACTOR`).
    pub ki: i128,
    /// Derivative gain Kd (scaled by `SCALING_FACTOR`).
    pub kd: i128,
}

impl PidGains {
    /// Creates a new `PidGains` parameter set.
    pub const fn new(kp: i128, ki: i128, kd: i128) -> Self {
        Self { kp, ki, kd }
    }
}

/// Output and updated state from a PID fee calculation step.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct PidResult {
    /// Recommended fee adjustment (positive = increase fee, negative = decrease fee).
    pub fee_adjustment: i128,
    /// Current calculated error: `current_congestion - target_congestion`.
    pub error: i128,
    /// Updated accumulated integral term (clamped within `[INTEGRAL_MIN, INTEGRAL_MAX]`).
    pub updated_integral: i128,
    /// Calculated derivative term: `(error - previous_error) / dt`.
    pub updated_derivative: i128,
}

/// Helper to multiply a value by a gain and divide by scale safely without panicking.
/// Uses checked multiplication and falls back to saturated values if overflow occurs.
#[inline]
pub fn scale_term(gain: i128, value: i128, scale: i128) -> i128 {
    if scale == 0 {
        return 0;
    }
    match gain.checked_mul(value) {
        Some(product) => product / scale,
        None => {
            // Saturated multiplication fallback when gain * value overflows i128
            if (gain > 0 && value > 0) || (gain < 0 && value < 0) {
                i128::MAX / scale
            } else {
                i128::MIN / scale
            }
        }
    }
}

/// Calculates the PID fee recommendation and updated state.
///
/// # Pure Calculation Function
/// - **error**: `current_congestion - target_congestion` (measured load relative to target).
///   When measured > target (congestion spike), `error > 0` and fee adjustment increases.
/// - **integral**: `accumulated_integral + error * dt`, clamped to `[INTEGRAL_MIN, INTEGRAL_MAX]`
///   to prevent windup during sustained spikes or lulls.
/// - **derivative**: `(error - previous_error) / dt` (rate of change of error).
/// - **output**: `(Kp * error + Ki * integral + Kd * derivative) / SCALING_FACTOR`,
///   computed using safe, overflow-checked fixed-point arithmetic.
///
/// # Arguments
/// * `current_congestion` - Measured congestion metric (i128).
/// * `target_congestion` - Target/baseline congestion metric (i128).
/// * `previous_error` - Error value from previous evaluation step (i128).
/// * `accumulated_integral` - Accumulated integral term before this step (i128).
/// * `dt` - Elapsed timestamp delta in seconds (u64).
/// * `gains` - PID gain coefficients (Kp, Ki, Kd scaled by `SCALING_FACTOR`).
///
/// # Returns
/// `PidResult` containing:
/// * `fee_adjustment` - Recommended fee adjustment (i128).
/// * `error` - Current error (`current_congestion - target_congestion`).
/// * `updated_integral` - Updated integral term clamped to `[INTEGRAL_MIN, INTEGRAL_MAX]`.
/// * `updated_derivative` - Rate of error change (`(error - previous_error) / dt`).
pub fn calculate_fee_adjustment(
    current_congestion: i128,
    target_congestion: i128,
    previous_error: i128,
    accumulated_integral: i128,
    dt: u64,
    gains: &PidGains,
) -> PidResult {
    // 1. Error calculation: current congestion minus target congestion.
    let error = current_congestion.saturating_sub(target_congestion);

    // 2. Integral accumulation with anti-windup clamping
    let dt_i128 = dt as i128;
    let delta_integral = match error.checked_mul(dt_i128) {
        Some(di) => di,
        None => {
            if (error > 0 && dt_i128 > 0) || (error < 0 && dt_i128 < 0) {
                i128::MAX
            } else {
                i128::MIN
            }
        }
    };
    let unconstrained_integral = accumulated_integral.saturating_add(delta_integral);
    let updated_integral = unconstrained_integral.clamp(INTEGRAL_MIN, INTEGRAL_MAX);

    // 3. Derivative calculation: rate of error change
    let updated_derivative = if dt == 0 {
        0
    } else {
        let error_diff = error.saturating_sub(previous_error);
        error_diff / dt_i128
    };

    // 4. PID Output components
    let p_term = scale_term(gains.kp, error, SCALING_FACTOR);
    let i_term = scale_term(gains.ki, updated_integral, SCALING_FACTOR);
    let d_term = scale_term(gains.kd, updated_derivative, SCALING_FACTOR);

    // 5. Total recommended fee adjustment (saturating addition prevents overflow)
    let fee_adjustment = p_term.saturating_add(i_term).saturating_add(d_term);

    PidResult {
        fee_adjustment,
        error,
        updated_integral,
        updated_derivative,
    }
}

/// Convenience wrapper accepting `u32` congestion metrics.
pub fn calculate_fee_adjustment_u32(
    current_congestion: u32,
    target_congestion: u32,
    previous_error: i128,
    accumulated_integral: i128,
    dt: u64,
    gains: &PidGains,
) -> PidResult {
    calculate_fee_adjustment(
        current_congestion as i128,
        target_congestion as i128,
        previous_error,
        accumulated_integral,
        dt,
        gains,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1.0 in fixed-point scaling
    const ONE: i128 = SCALING_FACTOR;

    #[test]
    fn test_steady_state() {
        // Steady-state: current congestion == target congestion (error == 0).
        // Output must stay 0 over multiple time steps.
        let gains = PidGains::new(ONE, ONE / 10, ONE / 2); // Kp = 1.0, Ki = 0.1, Kd = 0.5
        let target = 100i128;
        let mut previous_error = 0i128;
        let mut accumulated_integral = 0i128;
        let dt = 10u64;

        for _ in 0..5 {
            let result = calculate_fee_adjustment(
                target,
                target,
                previous_error,
                accumulated_integral,
                dt,
                &gains,
            );

            assert_eq!(result.error, 0);
            assert_eq!(result.fee_adjustment, 0);
            assert_eq!(result.updated_integral, 0);
            assert_eq!(result.updated_derivative, 0);

            previous_error = result.error;
            accumulated_integral = result.updated_integral;
        }
    }

    #[test]
    fn test_congestion_spike_and_decay() {
        // Congestion spike: current congestion exceeds target (error > 0).
        // Output increases on spike, then decays as congestion normalizes back to target.
        let gains = PidGains::new(ONE, ONE / 10, ONE / 2); // Kp = 1.0, Ki = 0.1, Kd = 0.5
        let target = 50i128;
        let mut prev_error = 0i128;
        let mut integral = 0i128;
        let dt = 5u64;

        // Step 1: Congestion spikes from 50 to 150 (error = +100)
        let spike = calculate_fee_adjustment(150, target, prev_error, integral, dt, &gains);
        assert_eq!(spike.error, 100);
        assert!(spike.fee_adjustment > 0, "Fee adjustment must be positive on spike");
        let initial_spike_adjustment = spike.fee_adjustment;

        // Verify components:
        // P = 1.0 * 100 = 100
        // I = 0.1 * (100 * 5) = 50
        // D = 0.5 * (100 / 5) = 10
        // Total = 100 + 50 + 10 = 160
        assert_eq!(spike.fee_adjustment, 160);

        prev_error = spike.error;
        integral = spike.updated_integral;

        // Step 2: Congestion normalizes back to target (current = 50, error = 0)
        let normalized = calculate_fee_adjustment(50, target, prev_error, integral, dt, &gains);
        assert_eq!(normalized.error, 0);
        // P term drops to 0. D term is negative: 0.5 * (-100 / 5) = -10.
        // I term is 0.1 * 500 = 50. Total = 0 + 50 - 10 = 40.
        assert!(
            normalized.fee_adjustment < initial_spike_adjustment,
            "Fee adjustment must decay after congestion normalizes"
        );
        assert_eq!(normalized.fee_adjustment, 40);
    }

    #[test]
    fn test_integral_windup_protection() {
        // Integral windup protection: sustained large error doesn't blow up integral term beyond bounds.
        let gains = PidGains::new(ONE, ONE, ONE);
        let target = 0i128;
        let large_congestion = 1_000_000_000i128;
        let mut integral = 0i128;
        let dt = 1000u64;

        // Run many iterations with massive error to trigger windup clamping
        for _ in 0..10 {
            let result = calculate_fee_adjustment(
                large_congestion,
                target,
                0,
                integral,
                dt,
                &gains,
            );
            integral = result.updated_integral;
        }

        // Must be capped at INTEGRAL_MAX
        assert_eq!(integral, INTEGRAL_MAX);

        // Test negative integral windup clamping
        let mut neg_integral = 0i128;
        let negative_congestion = -1_000_000_000i128;
        for _ in 0..10 {
            let result = calculate_fee_adjustment(
                negative_congestion,
                target,
                0,
                neg_integral,
                dt,
                &gains,
            );
            neg_integral = result.updated_integral;
        }

        // Must be capped at INTEGRAL_MIN
        assert_eq!(neg_integral, INTEGRAL_MIN);
    }

    #[test]
    fn test_overflow_underflow_safety_at_i128_boundaries() {
        // Tests extreme i128 boundary values to verify no panics occur.
        let extreme_gains = PidGains::new(i128::MAX, i128::MAX, i128::MAX);

        // Case 1: Max positive boundary conditions
        let res_max = calculate_fee_adjustment(
            i128::MAX,
            i128::MIN,
            i128::MIN,
            i128::MAX,
            u64::MAX,
            &extreme_gains,
        );
        assert!(res_max.fee_adjustment > 0);
        assert_eq!(res_max.updated_integral, INTEGRAL_MAX);

        // Case 2: Min negative boundary conditions
        let res_min = calculate_fee_adjustment(
            i128::MIN,
            i128::MAX,
            i128::MAX,
            i128::MIN,
            u64::MAX,
            &extreme_gains,
        );
        assert!(res_min.fee_adjustment < 0);
        assert_eq!(res_min.updated_integral, INTEGRAL_MIN);

        // Case 3: dt == 0 (zero timestamp delta must not divide by zero)
        let res_dt_zero = calculate_fee_adjustment(
            100,
            50,
            0,
            0,
            0,
            &PidGains::new(ONE, ONE, ONE),
        );
        assert_eq!(res_dt_zero.updated_derivative, 0);
        assert_eq!(res_dt_zero.error, 50);
    }

    #[test]
    fn test_u32_wrapper() {
        let gains = PidGains::new(ONE, ONE / 10, ONE / 2);
        let result = calculate_fee_adjustment_u32(100, 50, 0, 0, 10, &gains);
        assert_eq!(result.error, 50);
        assert!(result.fee_adjustment > 0);
    }
}
