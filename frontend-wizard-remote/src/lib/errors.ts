export const TRANSACTION_FAILED_MESSAGE = 'Transaction Failed' as const

const REGISTRY_CONTRACT_ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Due date must be in the future',
  2: 'Commitment not found',
  3: 'Commitment already resolved',
  4: 'Unauthorized',
  5: 'Invalid outcome',
  6: 'Contract already initialized',
  7: 'Not arbitrator',
  8: 'Dispute window expired',
  9: 'Invalid transition',
  10: 'Contract not initialized',
  11: 'Not authorized',
  12: 'Overflow',
  13: 'Reentrant call',
  14: 'Upgrade admin not set',
  15: 'Upgrade admin already set',
  16: 'Schema downgrade',
  17: 'Unsupported schema version',
  18: 'Migration not enabled',
  19: 'Batch too large',
  20: 'Invalid milestone count',
  21: 'Invalid milestone index',
  22: 'Milestone already attested',
  23: 'Milestone out of order',
  24: 'Empty arbitrator set',
  25: 'Already voted',
  26: 'Insufficient stake',
  27: 'Unbonding pending',
  28: 'Unbonding not elapsed',
  29: 'Dispute active',
  30: 'Staking token not set',
  31: 'Zero amount',
  32: 'Not attestor',
  33: 'Attestor already voted',
  34: 'Threshold invalid',
  35: 'Voting closed',
  36: 'Votes not met',
  37: 'Use voting resolution',
  38: 'Protocol paused',
})

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/i
const GENERIC_ERROR_CODE_PATTERN = /Error\s+Code\s+(\d+)/i

function extractRegistryErrorCode(source: string): number | null {
  const contractMatch = CONTRACT_ERROR_PATTERN.exec(source)
  if (contractMatch?.[1] !== undefined) {
    return Number.parseInt(contractMatch[1], 10)
  }

  const genericMatch = GENERIC_ERROR_CODE_PATTERN.exec(source)
  if (genericMatch?.[1] !== undefined) {
    return Number.parseInt(genericMatch[1], 10)
  }

  return null
}

function errorToSource(error: unknown): string | null {
  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    return error.message
  }

  return null
}

export function decodeRegistryContractError(error: unknown): string {
  const source = errorToSource(error)
  if (source === null) {
    return TRANSACTION_FAILED_MESSAGE
  }

  const code = extractRegistryErrorCode(source)
  if (code === null || !Number.isInteger(code)) {
    return TRANSACTION_FAILED_MESSAGE
  }

  if (Object.hasOwn(REGISTRY_CONTRACT_ERROR_MESSAGES, code)) {
    return REGISTRY_CONTRACT_ERROR_MESSAGES[code]
  }

  return TRANSACTION_FAILED_MESSAGE
}
