import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeRegistryContractError,
  TRANSACTION_FAILED_MESSAGE,
} from '../../src/lib/errors.ts'

describe('decodeRegistryContractError', () => {
  it('maps Error(Contract, #1) to the DueAtInPast message', () => {
    assert.equal(
      decodeRegistryContractError(new Error('Error(Contract, #1)')),
      'Due date must be in the future',
    )
  })

  it('maps Error Code 1 to the DueAtInPast message', () => {
    assert.equal(
      decodeRegistryContractError('Simulation failed: Error Code 1'),
      'Due date must be in the future',
    )
  })

  it('maps Error(Contract, #4) to Unauthorized', () => {
    assert.equal(
      decodeRegistryContractError(new Error('Error(Contract, #4)')),
      'Unauthorized',
    )
  })

  it('maps another known registry code without special-casing code 1', () => {
    assert.equal(
      decodeRegistryContractError('Error(Contract, #2)'),
      'Commitment not found',
    )
  })

  it('returns the generic fallback for an unknown contract code', () => {
    assert.equal(
      decodeRegistryContractError('Error(Contract, #999)'),
      TRANSACTION_FAILED_MESSAGE,
    )
  })

  it('returns the generic fallback for malformed input', () => {
    assert.equal(decodeRegistryContractError('not a soroban error'), TRANSACTION_FAILED_MESSAGE)
    assert.equal(decodeRegistryContractError({ reason: 'failed' }), TRANSACTION_FAILED_MESSAGE)
    assert.equal(decodeRegistryContractError(null), TRANSACTION_FAILED_MESSAGE)
  })

  it('does not expose sensitive markers from the original error', () => {
    const sensitiveMarker = 'SENSITIVE_FIXTURE_TOKEN_abc123'
    const result = decodeRegistryContractError(
      `Error(Contract, #999) ${sensitiveMarker}`,
    )

    assert.equal(result, TRANSACTION_FAILED_MESSAGE)
    assert.equal(result.includes(sensitiveMarker), false)
  })
})
