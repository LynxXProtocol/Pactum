import type { Commitment, Reputation } from '@/lib/api';
import type { StoredCommitment, StoredReputation } from './types';

/**
 * Merge the canonical (backend) commitment list into the local cache.
 *
 * The backend is the source of truth for commitments, except for records
 * that were created or edited offline and are still pending acknowledgement.
 * Those records are preserved so local changes are never lost when a device
 * comes back online. Local records that exist neither in the canonical list
 * nor in a pending state are removed, because the backend is authoritative
 * for deletions.
 */
export function mergeCommitmentsFromCanonical(
  local: StoredCommitment[],
  canonical: Commitment[],
  now = Date.now(),
): StoredCommitment[] {
  const seen = new Set<string>();
  const merged: StoredCommitment[] = [];

  for (const c of canonical) {
    const key = String(c.id);
    seen.add(key);
    const existing = local.find((l) => String(l.id) === key);

    if (existing?.pending) {
      // Offline edit that the backend has not acknowledged yet: keep the
      // local version and let the next write round-trip reconcile it.
      merged.push(existing);
    } else {
      merged.push({
        ...c,
        outcome: c.outcome ?? null,
        updatedAt: now,
        pending: false,
      });
    }
  }

  // Preserve locally-created commitments that are still waiting for the
  // backend to confirm them.
  for (const l of local) {
    if (!seen.has(String(l.id)) && l.pending) {
      merged.push(l);
    }
  }

  return merged;
}

/**
 * Merge canonical reputation records into the local cache. Reputation is a
 * read-only, server-derived aggregate, so canonical values always win and any
 * local record is refreshed with the latest server value.
 */
export function mergeReputationsFromCanonical(
  local: StoredReputation[],
  canonical: Reputation[],
  now = Date.now(),
): StoredReputation[] {
  const merged = new Map<string, StoredReputation>(local.map((r) => [r.address, r]));

  for (const r of canonical) {
    merged.set(r.address, { ...r, updatedAt: now });
  }

  return [...merged.values()];
}
