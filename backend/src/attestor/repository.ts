import { Pool } from 'pg';
import { queryTimescale } from '../db/timescale';
import { computeReliability } from './reliability';
import type {
  AttestorDiscoveryQuery,
  AttestorDiscoveryResult,
  AttestorRegistration,
  AttestorReliability,
} from './types';

export interface AttestorRepository {
  getReliability(address: string): Promise<AttestorReliability | null>;
  discoverAttestors(query: AttestorDiscoveryQuery): Promise<AttestorDiscoveryResult[]>;
  registerAttestor(reg: AttestorRegistration): Promise<void>;
  insertAssignments(commitmentId: string, attestors: string[]): Promise<void>;
  insertAttestorVote(args: {
    commitmentId: string;
    attestor: string;
    outcome: string;
    ledgerSequence: number;
  }): Promise<void>;
  insertDisputeOutcome(args: {
    commitmentId: string;
    finalOutcome: string;
    resolutionType: string;
  }): Promise<void>;
  upsertRegistryStake(attestor: string, delta: string): Promise<void>;
  attestorsForCommitment(commitmentId: string): Promise<string[]>;
}

const MAX_DISCOVER_LIMIT = 200;

export class PostgresAttestorRepository implements AttestorRepository {
  constructor(private readonly pool: Pool) {}

  async getReliability(address: string): Promise<AttestorReliability | null> {
    const result = await queryTimescale(
      `SELECT
         v.attestor,
         v.total_assigned,
         v.votes_cast,
         v.overturned,
         v.uptime_ratio,
         v.accuracy_ratio,
         v.successful_resolutions_ratio,
         COALESCE(r.fee, 0)      AS fee,
         COALESCE(r.domains, '{}') AS domains,
         COALESCE(r.active, FALSE) AS active,
         COALESCE(r.staked, 0)   AS staked
       FROM vw_attestor_reliability v
       LEFT JOIN attestor_registry r ON r.attestor = v.attestor
       WHERE v.attestor = $1
       LIMIT 1`,
      [address],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.toReliability(row);
  }

  async discoverAttestors(query: AttestorDiscoveryQuery): Promise<AttestorDiscoveryResult[]> {
    // $1 is reserved for the accuracy weight so the ranking matches the score.
    const params: unknown[] = [Number(process.env.ATTESTOR_ACCURACY_WEIGHT ?? 1)];
    const conditions: string[] = ['r.active = TRUE', 'r.staked > 0'];

    if (typeof query.maxFee === 'number') {
      params.push(query.maxFee);
      conditions.push(`r.fee <= $${params.length}`);
    }
    if (typeof query.domain === 'string' && query.domain.length > 0) {
      params.push(query.domain);
      conditions.push(`r.domains && ARRAY[$${params.length}]::text[]`);
    }
    if (typeof query.minReliability === 'number') {
      params.push(query.minReliability);
      // successful_resolutions_ratio * Accuracy_Weight >= minReliability
      conditions.push(`v.successful_resolutions_ratio * $1 >= $${params.length}`);
    }

    const limit = Math.min(Math.max(1, Number(query.limit) || 50), MAX_DISCOVER_LIMIT);
    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await queryTimescale(
      `SELECT
         r.attestor,
         r.fee,
         r.domains,
         r.active,
         r.staked,
         v.total_assigned,
         v.votes_cast,
         v.overturned,
         v.uptime_ratio,
         v.accuracy_ratio,
         (v.successful_resolutions_ratio * $1) AS reliability_score
       FROM attestor_registry r
       JOIN vw_attestor_reliability v ON v.attestor = r.attestor
       ${where}
       ORDER BY reliability_score DESC, r.fee ASC, r.attestor ASC
       LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row) => this.toDiscovery(row));
  }

  async registerAttestor(reg: AttestorRegistration): Promise<void> {
    await queryTimescale(
      `INSERT INTO attestor_registry (attestor, fee, domains, active, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (attestor) DO UPDATE SET
         fee = COALESCE(EXCLUDED.fee, attestor_registry.fee),
         domains = COALESCE(EXCLUDED.domains, attestor_registry.domains),
         active = COALESCE(EXCLUDED.active, attestor_registry.active),
         updated_at = NOW()`,
      [
        reg.attestor,
        reg.fee ?? 0,
        reg.domains ?? [],
        reg.active ?? true,
      ],
    );
  }

  async insertAssignments(commitmentId: string, attestors: string[]): Promise<void> {
    if (attestors.length === 0) return;
    const values = attestors
      .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
      .join(', ');
    const params = attestors.flatMap((attestor) => [commitmentId, attestor]);
    await queryTimescale(
      `INSERT INTO attestor_assignments (commitment_id, attestor)
       VALUES ${values}
       ON CONFLICT (commitment_id, attestor) DO NOTHING`,
      params,
    );
  }

  async insertAttestorVote(args: {
    commitmentId: string;
    attestor: string;
    outcome: string;
    ledgerSequence: number;
  }): Promise<void> {
    await queryTimescale(
      `INSERT INTO attestor_votes (commitment_id, attestor, outcome, ledger_sequence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (commitment_id, attestor) DO UPDATE SET
         outcome = EXCLUDED.outcome,
         ledger_sequence = EXCLUDED.ledger_sequence,
         voted_at = NOW()`,
      [args.commitmentId, args.attestor, args.outcome, args.ledgerSequence],
    );
  }

  async insertDisputeOutcome(args: {
    commitmentId: string;
    finalOutcome: string;
    resolutionType: string;
  }): Promise<void> {
    await queryTimescale(
      `INSERT INTO attestor_dispute_outcomes (commitment_id, final_outcome, resolution_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (commitment_id) DO UPDATE SET
         final_outcome = EXCLUDED.final_outcome,
         resolution_type = EXCLUDED.resolution_type,
         resolved_at = NOW()`,
      [args.commitmentId, args.finalOutcome, args.resolutionType],
    );
  }

  async upsertRegistryStake(attestor: string, delta: string): Promise<void> {
    await queryTimescale(
      `INSERT INTO attestor_registry (attestor, staked, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (attestor) DO UPDATE SET
         staked = GREATEST(0, attestor_registry.staked + $2),
         updated_at = NOW()`,
      [attestor, delta],
    );
  }

  async attestorsForCommitment(commitmentId: string): Promise<string[]> {
    const result = await queryTimescale(
      `SELECT attestor FROM attestor_votes WHERE commitment_id = $1`,
      [commitmentId],
    );
    return result.rows.map((r) => String(r.attestor));
  }

  private toReliability(row: Record<string, unknown>): AttestorReliability {
    const base = computeReliability({
      totalAssigned: Number(row.total_assigned),
      votesCast: Number(row.votes_cast),
      overturned: Number(row.overturned),
    });
    return { ...base, attestor: String(row.attestor) };
  }

  private toDiscovery(row: Record<string, unknown>): AttestorDiscoveryResult {
    return {
      attestor: String(row.attestor),
      fee: Number(row.fee),
      domains: Array.isArray(row.domains) ? (row.domains as string[]) : [],
      active: Boolean(row.active),
      staked: Number(row.staked),
      reliabilityScore: Number(row.reliability_score),
      totalAssigned: Number(row.total_assigned),
      votesCast: Number(row.votes_cast),
      overturned: Number(row.overturned),
      uptimeRatio: Number(row.uptime_ratio),
      accuracyRatio: Number(row.accuracy_ratio),
    };
  }
}
