//! Fast unit tests for pure economics (no Soroban host).

use super::*;

#[test]
fn slash_cut_ten_percent() {
    let cut = slash_cut(1_000, SLASH_PERCENT_OF_STAKE).expect("ok");
    assert_eq!(cut.cut, 100);
    assert_eq!(cut.remaining, 900);
}

#[test]
fn slash_cut_rejects_percent_over_100() {
    assert!(slash_cut(1_000, 101).is_none());
}

#[test]
fn slash_cut_zero_stake_is_noop() {
    let cut = slash_cut(0, SLASH_PERCENT_OF_STAKE).expect("ok");
    assert_eq!(cut.cut, 0);
    assert_eq!(cut.remaining, 0);
}

#[test]
fn slash_accounting_preserves_vault_tokens() {
    let (remaining, vault) = apply_slash_accounting(500, 2_000, 10).expect("ok");
    assert_eq!(remaining, 450);
    assert_eq!(vault, 2_000);
}

#[test]
fn vault_covers_recorded_after_slash_surplus() {
    let mut snap = VaultSnapshot {
        vault_tokens: 1_000,
        recorded: [400, 600, 0, 0],
        len: 2,
    };
    assert!(vault_covers_recorded_stakes(&snap));

    // Slash attestor 1 by 10%: recorded drops, vault unchanged → surplus grows.
    let cut = slash_cut(snap.recorded[1], 10).expect("ok");
    snap.recorded[1] = cut.remaining;
    assert!(vault_covers_recorded_stakes(&snap));
    assert_eq!(snap.total_recorded(), Some(400 + 540));
    assert!(snap.vault_tokens > snap.total_recorded().unwrap());
}

#[test]
fn policy_spares_on_timeout_path() {
    assert_eq!(
        should_slash_attestor(false, true, false),
        SlashDecision::Spare
    );
}

#[test]
fn policy_slashes_only_dissenting_voters() {
    assert_eq!(
        should_slash_attestor(true, true, false),
        SlashDecision::Slash
    );
    assert_eq!(
        should_slash_attestor(true, true, true),
        SlashDecision::Spare
    );
    assert_eq!(
        should_slash_attestor(true, false, false),
        SlashDecision::Spare
    );
}

#[test]
fn recorded_conservation_across_panel_slash() {
    // Σ remaining + Σ cuts == Σ original for dissenters only.
    let stakes = [1_000_i128, 800, 500];
    let dissent = [false, true, true];
    let mut sum_orig = 0_i128;
    let mut sum_remain = 0_i128;
    let mut sum_cuts = 0_i128;
    for i in 0..stakes.len() {
        sum_orig += stakes[i];
        let decision = should_slash_attestor(true, true, !dissent[i]);
        match decision {
            SlashDecision::Slash => {
                let c = slash_cut(stakes[i], SLASH_PERCENT_OF_STAKE).expect("ok");
                sum_remain += c.remaining;
                sum_cuts += c.cut;
            }
            SlashDecision::Spare => {
                sum_remain += stakes[i];
            }
        }
    }
    assert_eq!(sum_remain + sum_cuts, sum_orig);
}
