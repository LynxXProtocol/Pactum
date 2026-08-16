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
    /// No upgrade admin has been installed, so no upgrade path exists.
    UpgradeAdminNotSet = 14,
    /// The bootstrap upgrade-admin path is closed; use the timelocked transfer.
    UpgradeAdminAlreadySet = 15,
    /// The requested schema version is lower than the version currently in force.
    SchemaDowngrade = 16,
    /// The requested schema version is not understood by this executable.
    UnsupportedSchemaVersion = 17,
    /// Reputation migration was requested while the contract is still on schema V1.
    MigrationNotEnabled = 18,
    /// The requested migration batch exceeds the maximum batch size.
    BatchTooLarge = 19,
}
