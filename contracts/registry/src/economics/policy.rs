//! Policy rules for *who* gets slashed when a dispute resolves.

/// Protocol slash rate used by the voting phase (`voting::SLASH_PERCENT`).
pub const SLASH_PERCENT_OF_STAKE: u64 = 10;

/// Same rate expressed in basis points (1_000 = 10%).
pub const SLASH_PERCENT_BPS: u64 = 1_000;

/// Outcome of the slash-eligibility decision for one panel attestor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SlashDecision {
    /// Apply `SLASH_PERCENT_OF_STAKE` to the attestor's recorded stake.
    Slash,
    /// Leave the attestor's stake untouched.
    Spare,
}

/// Decides whether an attestor should be slashed when a dispute panel unlocks.
///
/// Mirrors `voting::unlock_panel_and_clear`:
/// - Timeout / no-slash paths pass `slash_dissenters = false` → everyone spared.
/// - Threshold resolution with `slash_dissenters = true` slashes only panel
///   members who cast a vote that differs from `winning_outcome`.
/// - Abstainers (no vote) are spared.
pub fn should_slash_attestor(
    slash_dissenters: bool,
    cast_a_vote: bool,
    voted_with_winner: bool,
) -> SlashDecision {
    if !slash_dissenters {
        return SlashDecision::Spare;
    }
    if !cast_a_vote {
        return SlashDecision::Spare;
    }
    if voted_with_winner {
        return SlashDecision::Spare;
    }
    SlashDecision::Slash
}
