use soroban_sdk::contracterror;

/// Custom errors for the Pactum registry contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The specified due date is in the past relative to the current ledger timestamp.
    DueAtInPast = 1,
    /// No commitment was found with the specified ID.
    CommitmentNotFound = 2,
    /// The commitment is no longer in Pending status and has already been resolved.
    AlreadyResolved = 3,
    /// The caller is not authorized to perform this action on the commitment.
    Unauthorized = 4,
    /// The provided outcome status is invalid (e.g., attempting to attest as Pending).
    InvalidOutcome = 5,
    /// The contract has already been initialized.
    AlreadyInitialized = 6,
    /// The caller is not the designated arbitrator.
    NotArbitrator = 7,
    /// The dispute window for this commitment has expired.
    DisputeWindowExpired = 8,
    /// The transition is invalid for the current commitment status.
    InvalidTransition = 9,
    /// The contract has not been initialized.
    NotInitialized = 10,
    /// The caller is not authorized to perform this action.
    NotAuthorized = 11,
    /// Numerical overflow occurred when calculating ID or timestamps.
    Overflow = 12,
    /// A state-mutating registry function was re-entered while a call to
    /// another state-mutating registry function was already in progress.
    ReentrantCall = 13,
    /// The escrow token amount is invalid (must be greater than zero).
    InvalidAmount = 14,
    /// No escrow was found for the specified commitment ID.
    EscrowNotFound = 15,
    /// The escrow funds have already been released.
    EscrowAlreadyReleased = 16,
    /// The commitment has not reached a resolved state (Fulfilled, Late, or Breached).
    CommitmentNotResolved = 17,
    /// The dispute window is still active; escrow settlement cannot proceed until it expires.
    DisputeWindowActive = 18,
}

