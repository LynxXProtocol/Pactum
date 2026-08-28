import type { AttestorReliability, AttestorStats } from './types';

/**
 * Tunable multiplier in the reliability formula
 *   Reliability = (Successful_Resolutions / Total_Assigned) * Accuracy_Weight
 *
 * Defaults to 1.0; raise it (e.g. via ATTESTOR_ACCURACY_WEIGHT) to weight the
 * accuracy term more heavily relative to mere participation.
 */
export const ACCURACY_WEIGHT = Number(process.env.ATTESTOR_ACCURACY_WEIGHT ?? 1);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Pure, side-effect-free scoring used by both the API layer and the unit tests.
 *
 * Definitions (matching issue #63):
 *   - uptime     = did the attestor vote before the timeout? Any `votecast`
 *                 event is, by contract construction, before the window closed,
 *                 so uptime = votesCast / totalAssigned.
 *   - accuracy   = were their votes overturned? A vote is overturned when its
 *                 outcome differs from the dispute's final outcome, so
 *                 accuracy = (votesCast - overturned) / votesCast.
 *   - reliability = (votesCast - overturned) / totalAssigned * Accuracy_Weight
 *                 = Successful_Resolutions / Total_Assigned * Accuracy_Weight.
 */
export function computeReliability(stats: AttestorStats, accuracyWeight = ACCURACY_WEIGHT): AttestorReliability {
  const totalAssigned = Math.max(0, Number(stats.totalAssigned) || 0);
  const votesCast = Math.max(0, Number(stats.votesCast) || 0);
  const overturned = Math.max(0, Math.min(votesCast, Number(stats.overturned) || 0));

  const successful = votesCast - overturned;

  const uptimeRatio = totalAssigned > 0 ? clamp01(votesCast / totalAssigned) : 0;
  const accuracyRatio = votesCast > 0 ? clamp01(successful / votesCast) : 0;
  const successfulResolutionsRatio = totalAssigned > 0 ? clamp01(successful / totalAssigned) : 0;
  const reliabilityScore = clamp01(successfulResolutionsRatio * accuracyWeight);

  return {
    attestor: '',
    totalAssigned,
    votesCast,
    overturned,
    uptimeRatio,
    accuracyRatio,
    successfulResolutionsRatio,
    reliabilityScore,
  };
}
