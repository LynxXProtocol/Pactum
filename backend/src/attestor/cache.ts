import { KeyValueCache, createRedisClientFromEnv } from '../cache/reputationCache';
import type { AttestorDiscoveryQuery, AttestorDiscoveryResult, AttestorReliability } from './types';

export const ATTESTOR_RELIABILITY_PREFIX = 'attestor_reliability:';
export const ATTESTOR_DISCOVERY_PREFIX = 'attestor_discovery:';

export interface AttestorCacheOptions {
  reliabilityTtlSeconds?: number;
  discoveryTtlSeconds?: number;
}

/**
 * Redis front for the attestor reliability score and the discovery results.
 * Mirrors the reputation cache: a per-address reliability entry plus a
 * short-lived discovery entry keyed by the normalised query.
 */
export class AttestorCache {
  private readonly reliabilityTtl: number;
  private readonly discoveryTtl: number;

  constructor(
    private readonly redis: KeyValueCache,
    private readonly repository: {
      getReliability(address: string): Promise<AttestorReliability | null>;
      discoverAttestors(query: AttestorDiscoveryQuery): Promise<AttestorDiscoveryResult[]>;
    },
    options: AttestorCacheOptions = {},
  ) {
    this.reliabilityTtl = options.reliabilityTtlSeconds ?? 300;
    this.discoveryTtl = options.discoveryTtlSeconds ?? 10;
  }

  static reliabilityKey(address: string): string {
    return `${ATTESTOR_RELIABILITY_PREFIX}${address}`;
  }

  private static discoveryKey(query: AttestorDiscoveryQuery): string {
    const normalised = JSON.stringify({
      maxFee: query.maxFee ?? null,
      domain: query.domain ?? null,
      minReliability: query.minReliability ?? null,
      limit: query.limit ?? null,
      cursor: query.cursor ?? null,
    });
    return `${ATTESTOR_DISCOVERY_PREFIX}${Buffer.from(normalised).toString('base64url')}`;
  }

  async getReliability(address: string): Promise<AttestorReliability | null> {
    const key = AttestorCache.reliabilityKey(address);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return JSON.parse(cached) as AttestorReliability;
    } catch {
      // fall through to the source of truth
    }
    const value = await this.repository.getReliability(address);
    try {
      if (value) await this.redis.setex(key, this.reliabilityTtl, JSON.stringify(value));
      else await this.redis.del(key);
    } catch {
      // best-effort cache write
    }
    return value;
  }

  async invalidate(address: string): Promise<void> {
    await this.redis.del(AttestorCache.reliabilityKey(address));
  }

  async getDiscovery(
    query: AttestorDiscoveryQuery,
  ): Promise<AttestorDiscoveryResult[]> {
    const key = AttestorCache.discoveryKey(query);
    try {
      const cached = await this.redis.get(key);
      if (cached !== null) return JSON.parse(cached) as AttestorDiscoveryResult[];
    } catch {
      // fall through to the source of truth
    }
    const value = await this.repository.discoverAttestors(query);
    try {
      await this.redis.setex(key, this.discoveryTtl, JSON.stringify(value));
    } catch {
      // best-effort cache write
    }
    return value;
  }

  /** Discovery results are intentionally short-lived (see discoveryTtlSeconds). */
}

export function createAttestorRedisClient(): ReturnType<typeof createRedisClientFromEnv> {
  return createRedisClientFromEnv();
}
