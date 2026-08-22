//! Slash cut arithmetic used by the attestor vault.

/// Result of computing a slash cut from a staked balance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SlashCut {
    /// Amount deducted from the attestor's recorded stake.
    pub cut: i128,
    /// Recorded stake after applying the cut.
    pub remaining: i128,
}

/// Computes `staked * percent / 100` with checked arithmetic.
///
/// Returns `None` on overflow or if `percent > 100`. A non-positive `staked`
/// yields a zero cut and unchanged remaining balance (matches `staking::slash`).
pub fn slash_cut(staked: i128, percent: u64) -> Option<SlashCut> {
    if percent > 100 {
        return None;
    }
    if staked <= 0 {
        return Some(SlashCut {
            cut: 0,
            remaining: staked,
        });
    }
    let cut = staked
        .checked_mul(percent as i128)?
        .checked_div(100)?;
    if cut <= 0 {
        return Some(SlashCut {
            cut: 0,
            remaining: staked,
        });
    }
    let remaining = staked.checked_sub(cut)?;
    Some(SlashCut { cut, remaining })
}

/// Applies slash accounting: recorded stake decreases by `cut`, vault token
/// balance is unchanged (forfeited funds stay in the vault until distribution).
///
/// Returns the post-slash `(recorded_stake, vault_tokens)` or `None` on overflow.
pub fn apply_slash_accounting(
    recorded_stake: i128,
    vault_tokens: i128,
    percent: u64,
) -> Option<(i128, i128)> {
    let SlashCut { remaining, .. } = slash_cut(recorded_stake, percent)?;
    // Tokens never leave the vault on slash — conservation of vault_tokens.
    Some((remaining, vault_tokens))
}
