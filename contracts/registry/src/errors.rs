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
    /// The requested milestone count is zero or above `MAX_MILESTONES`.
    InvalidMilestoneCount = 20,
    /// The requested milestone index is outside the commitment's milestone range.
    InvalidMilestoneIndex = 21,
    /// The requested milestone has already been attested.
    MilestoneAlreadyAttested = 22,
    /// Milestones must be attested in order and an earlier one is still pending.
    MilestoneOutOfOrder = 23,
    /// The arbitrator set passed to `initialize` was empty.
    EmptyArbitratorSet = 24,
    /// An arbitrator attempted to cast a second vote on the same dispute.
    AlreadyVoted = 25,
    /// The attestor does not hold a stake sufficient for the requested operation.
    InsufficientStake = 26,
    /// An unstake has already been requested and is still pending for this attestor.
    UnbondingPending = 27,
    /// The unbonding period for this unstake has not elapsed yet.
    UnbondingNotElapsed = 28,
    /// A dispute is active, so the attestor's stake is locked.
    DisputeActive = 29,
    /// No staking token has been configured for the registry.
    StakingTokenNotSet = 30,
    /// The requested staking amount is zero or negative.
    ZeroAmount = 31,
    /// The caller is not a designated attestor on the commitment's voting panel.
    NotAttestor = 32,
    /// The attestor has already cast a vote on this disputed commitment.
    AttestorAlreadyVoted = 33,
    /// The vote threshold is invalid (zero when a panel exists, above the panel
    /// size, or a panel is missing while a threshold is set).
    ThresholdInvalid = 34,
    /// The attestor voting window for this dispute has closed.
    VotingClosed = 35,
    /// The attestor vote threshold has not been reached yet.
    VotesNotMet = 36,
    /// This commitment is governed by M-of-N attestor voting; single-resolver
    /// resolution is not permitted.
    UseVotingResolution = 37,
    /// The protocol is currently paused.
    ProtocolPaused = 38,
    /// The reputation (or trust-history) entry for this address has been
    /// archived by Soroban state expiration and must be restored before it
    /// can be read or mutated.  Callers should submit a `RestoreFootprint`
    /// operation — or invoke `restore_reputation` — and retry.
    ReputationArchived = 39,
    /// No dispute token has been configured for the registry.
    DisputeTokenNotSet = 40,
    /// The dispute stake amount must be greater than zero.
    InvalidDisputeStakeAmount = 41,
    /// Forced inclusion was attempted before the rollup challenge window elapsed.
    RollupChallengePending = 42,
    /// The provided Merkle proof does not resolve to the expected batch root.
    RollupProofInvalid = 43,
    /// The fee oracle has not yet received enough observations to produce a
    /// recommendation.
    OracleNotInitialized = 44,
}
