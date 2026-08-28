export type AttestorOutcome = 'fulfilled' | 'late' | 'breached';

/** Raw counters behind a reliability score, as emitted by `vw_attestor_reliability`. */
export interface AttestorStats {
  totalAssigned: number;
  votesCast: number;
  overturned: number;
}

/** A fully computed reliability record for a single attestor. */
export interface AttestorReliability extends AttestorStats {
  attestor: string;
  /** Successful_Resolutions / Total_Assigned (0 when never assigned). */
  successfulResolutionsRatio: number;
  /** votesCast / totalAssigned — did they vote before the timeout? */
  uptimeRatio: number;
  /** (votesCast - overturned) / votesCast — were their votes overturned? */
  accuracyRatio: number;
  /** (Successful_Resolutions / Total_Assigned) * Accuracy_Weight. */
  reliabilityScore: number;
}

export interface AttestorDiscoveryQuery {
  maxFee?: number;
  domain?: string;
  minReliability?: number;
  limit?: number;
  cursor?: string;
}

/** A ranked, filtered attestor returned by the discovery engine. */
export interface AttestorDiscoveryResult {
  attestor: string;
  fee: number;
  domains: string[];
  active: boolean;
  staked: number;
  reliabilityScore: number;
  totalAssigned: number;
  votesCast: number;
  overturned: number;
  uptimeRatio: number;
  accuracyRatio: number;
}

export interface AttestorRegistration {
  attestor: string;
  fee?: number;
  domains?: string[];
  active?: boolean;
}
