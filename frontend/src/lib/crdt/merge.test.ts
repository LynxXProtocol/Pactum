import { describe, expect, it } from 'vitest'

import type { Commitment, Reputation } from '@/lib/api'
import { mergeCommitmentsFromCanonical, mergeReputationsFromCanonical } from './merge'
import type { StoredCommitment, StoredReputation } from './types'

const BASE: Omit<Commitment, 'id'> = {
  issuer: 'GBY54VG5G4A7DC4D6YJ6GHD4X4QW2AR43JLYZ2QVWSHKACWK3BLDR5IX',
  counterparty: 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX',
  terms_hash: 'a3f9c1d2e4b5678901234567890abcdef1234567890abcdef1234567890ab',
  due_at: 1700000000,
  status: 'Pending',
  outcome: null,
}

function commitment(id: number, overrides: Partial<Commitment> = {}): Commitment {
  return { id, ...BASE, ...overrides }
}

function stored(id: number, overrides: Partial<StoredCommitment> = {}): StoredCommitment {
  return { ...commitment(id), updatedAt: 1, pending: false, ...overrides }
}

const NOW = 1_700_000_000_000

describe('mergeCommitmentsFromCanonical', () => {
  it('adopts canonical state when there is no local cache', () => {
    const result = mergeCommitmentsFromCanonical([], [commitment(1), commitment(2)], NOW)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 1, pending: false, updatedAt: NOW })
    expect(result[1]).toMatchObject({ id: 2, pending: false, updatedAt: NOW })
  })

  it('overwrites a stale local record with the canonical record', () => {
    const local = stored(1, { status: 'Pending', updatedAt: 100 })
    const canonical = commitment(1, { status: 'Fulfilled' })

    const result = mergeCommitmentsFromCanonical([local], [canonical], NOW)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 1, status: 'Fulfilled', pending: false, updatedAt: NOW })
  })

  it('preserves a pending local edit that the backend has not acknowledged yet', () => {
    const local = stored(1, { status: 'Pending', updatedAt: 5000, pending: true })
    const canonical = commitment(1, { status: 'Fulfilled' })

    const result = mergeCommitmentsFromCanonical([local], [canonical], NOW)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 1, status: 'Pending', pending: true })
    expect(result[0].updatedAt).toBe(5000)
  })

  it('keeps a locally-created commitment that is not yet present on the backend', () => {
    const local = stored(42, { status: 'Pending', updatedAt: 5000, pending: true })

    const result = mergeCommitmentsFromCanonical([local], [commitment(1)], NOW)

    expect(result.map((c) => c.id)).toEqual([1, 42])
    expect(result.find((c) => c.id === 42)).toMatchObject({ pending: true })
  })

  it('drops a local non-pending record that no longer exists on the backend', () => {
    const local = stored(1, { pending: false })

    const result = mergeCommitmentsFromCanonical([local], [commitment(2)], NOW)

    expect(result.map((c) => c.id)).toEqual([2])
  })

  it('carries the attested outcome through and falls back to null when absent', () => {
    const result = mergeCommitmentsFromCanonical([], [commitment(3, { outcome: 'Late' })], NOW)
    expect(result[0].outcome).toBe('Late')

    const noOutcome = mergeCommitmentsFromCanonical([], [commitment(4, { outcome: null })], NOW)
    expect(noOutcome[0].outcome).toBeNull()
  })
})

describe('mergeReputationsFromCanonical', () => {
  const local: StoredReputation[] = [
    { address: 'GABC', fulfilled: 5, late: 1, breached: 0, total: 6, updatedAt: 100 },
  ]

  it('refreshes an existing address with the canonical record', () => {
    const canonical: Reputation = { address: 'GABC', fulfilled: 8, late: 2, breached: 1, total: 11 }

    const result = mergeReputationsFromCanonical(local, [canonical], NOW)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ address: 'GABC', fulfilled: 8, total: 11, updatedAt: NOW })
  })

  it('keeps local-only reputation entries alongside canonical ones', () => {
    const canonical: Reputation = { address: 'GDEF', fulfilled: 0, late: 0, breached: 0, total: 0 }

    const result = mergeReputationsFromCanonical(local, [canonical], NOW)

    expect(result).toHaveLength(2)
  })
})