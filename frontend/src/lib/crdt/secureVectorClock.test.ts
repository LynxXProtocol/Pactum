import { describe, expect, it } from 'vitest'

import {
  createSecureVectorClock,
  verifySecureVectorClock,
  mergeVectorClocks,
  happensBefore,
  areConcurrent,
} from './secureVectorClock'
import { createSessionIdentity } from './signing'

async function makeIdentity() {
  const address = crypto.randomUUID()
  const identity = await createSessionIdentity(address)
  return { identity }
}

describe('mergeVectorClocks', () => {
  it('merges two clocks taking the max of each counter', () => {
    const a = { alice: 3, bob: 1 }
    const b = { alice: 1, bob: 4, charlie: 2 }
    const { merged, advanced } = mergeVectorClocks(a, b)
    expect(merged).toEqual({ alice: 3, bob: 4, charlie: 2 })
    expect(advanced).toBe(true)
  })

  it('returns advanced=false when both clocks are identical', () => {
    const a = { alice: 2, bob: 3 }
    const b = { bob: 3, alice: 2 }
    const { advanced } = mergeVectorClocks(a, b)
    expect(advanced).toBe(false)
  })

  it('handles empty clocks', () => {
    const { merged } = mergeVectorClocks({}, {})
    expect(merged).toEqual({})
  })
})

describe('happensBefore', () => {
  it('returns true when A is strictly before B', () => {
    expect(happensBefore({ alice: 1 }, { alice: 2 })).toBe(true)
  })

  it('returns false when A equals B', () => {
    expect(happensBefore({ alice: 1 }, { alice: 1 })).toBe(false)
  })

  it('returns false when A is after B', () => {
    expect(happensBefore({ alice: 2 }, { alice: 1 })).toBe(false)
  })

  it('returns true when A is subset of B', () => {
    expect(happensBefore({ alice: 1 }, { alice: 1, bob: 1 })).toBe(true)
  })

  it('returns false for concurrent clocks', () => {
    expect(happensBefore({ alice: 2, bob: 1 }, { alice: 1, bob: 2 })).toBe(false)
  })
})

describe('areConcurrent', () => {
  it('returns true for concurrent clocks', () => {
    expect(areConcurrent({ alice: 2, bob: 1 }, { alice: 1, bob: 2 })).toBe(true)
  })

  it('returns false when one dominates the other', () => {
    expect(areConcurrent({ alice: 1 }, { alice: 2 })).toBe(false)
  })

  it('returns false for identical clocks', () => {
    expect(areConcurrent({ alice: 1 }, { alice: 1 })).toBe(false)
  })
})

describe('createSecureVectorClock', () => {
  it('creates a clock with a signed local entry', async () => {
    const { identity } = await makeIdentity()
    const clock = await createSecureVectorClock(identity, 5)
    expect(clock.entries[identity.address]).toBeDefined()
    expect(clock.entries[identity.address].counter).toBe(5)
    expect(clock.entries[identity.address].signature.length).toBeGreaterThan(0)
  })

  it('includes peer counters as witness-signed entries', async () => {
    const { identity } = await makeIdentity()
    const clock = await createSecureVectorClock(identity, 1, { bob: 3, charlie: 2 })
    expect(clock.entries['bob']?.counter).toBe(3)
    expect(clock.entries['charlie']?.counter).toBe(2)
  })

  it('produces deterministic serialized form', async () => {
    const { identity } = await makeIdentity()
    const a = await createSecureVectorClock(identity, 1, { bob: 2 })
    const b = await createSecureVectorClock(identity, 1, { bob: 2 })
    expect(a.serialized).toBe(b.serialized)
  })
})

describe('verifySecureVectorClock', () => {
  it('verifies a freshly created clock', async () => {
    const { identity } = await makeIdentity()

    const publicKeys = new Map<string, CryptoKey>()
    publicKeys.set(identity.address, identity.keyPair.publicKey)

    // We need Bob's public key too, but for this test we only verify our own entry.
    // Create a clock with just our entry for clean verification.
    const localClock = await createSecureVectorClock(identity, 1)
    const valid = await verifySecureVectorClock(localClock, publicKeys)
    expect(valid).toBe(true)
  })

  it('rejects a clock with a tampered counter', async () => {
    const { identity } = await makeIdentity()
    const clock = await createSecureVectorClock(identity, 1)

    // Tamper with the counter.
    const tampered = {
      ...clock,
      entries: {
        ...clock.entries,
        [identity.address]: {
          ...clock.entries[identity.address],
          counter: 999,
        },
      },
    }

    const publicKeys = new Map<string, CryptoKey>()
    publicKeys.set(identity.address, identity.keyPair.publicKey)

    const valid = await verifySecureVectorClock(tampered, publicKeys)
    expect(valid).toBe(false)
  })

  it('rejects a clock from an unknown author', async () => {
    const { identity } = await makeIdentity()
    const clock = await createSecureVectorClock(identity, 1)
    const publicKeys = new Map<string, CryptoKey>()
    // Do not add the identity address to public keys.
    const valid = await verifySecureVectorClock(clock, publicKeys)
    expect(valid).toBe(false)
  })
})
