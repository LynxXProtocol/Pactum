//! Vault-level conservation helpers (Issue #192 TVL modelling).

/// Upper bound on how many attestors a BMC harness will explore.
/// Kept small so Kani stays tractable.
pub const MAX_MODELLED_ATTESTORS: usize = 4;

/// Snapshot of vault economics used by invariant checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultSnapshot {
    /// Token balance held by the contract vault.
    pub vault_tokens: i128,
    /// Per-attestor recorded stakes (length ≤ `MAX_MODELLED_ATTESTORS`).
    pub recorded: [i128; MAX_MODELLED_ATTESTORS],
    /// How many entries in `recorded` are live.
    pub len: usize,
}

impl VaultSnapshot {
    /// Sum of recorded stakes across live attestors.
    pub fn total_recorded(&self) -> Option<i128> {
        let mut sum: i128 = 0;
        for i in 0..self.len.min(MAX_MODELLED_ATTESTORS) {
            sum = sum.checked_add(self.recorded[i])?;
        }
        Some(sum)
    }
}

/// Invariant 7 (weak TVL): vault token balance covers all recorded stakes.
///
/// Slash leaves tokens in the vault while reducing recorded stake, so the
/// relation is `>=` rather than `==`.
pub fn vault_covers_recorded_stakes(snap: &VaultSnapshot) -> bool {
    match snap.total_recorded() {
        Some(total) => total >= 0 && snap.vault_tokens >= total,
        None => false,
    }
}
