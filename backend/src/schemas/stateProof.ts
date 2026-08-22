import { z } from 'zod';

const hex32Regex = /^0x[0-9a-fA-F]{64}$/;
const UINT32_MAX = 4294967295;

export const scoreDataSchema = z.object({
  score: z.number().int().min(0).max(100),
  fulfilledCount: z.number().int().min(0).max(UINT32_MAX),
  lateCount: z.number().int().min(0).max(UINT32_MAX),
  breachedCount: z.number().int().min(0).max(UINT32_MAX),
  epoch: z.number().int().min(0).max(UINT32_MAX),
  sourceLedgerSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const merkleProofNodeSchema = z.object({
  sibling: z.string().regex(hex32Regex, 'Sibling must be a 32-byte hex string (0x...)'),
  isRight: z.boolean(),
}).strict();

export const headerProofSchema = z.object({
  previousLedgerHash: z.string().regex(hex32Regex, 'previousLedgerHash must be a 32-byte hex string'),
  txSetResultHash: z.string().regex(hex32Regex, 'txSetResultHash must be a 32-byte hex string'),
  bucketListHash: z.string().regex(hex32Regex, 'bucketListHash must be a 32-byte hex string'),
  ledgerVersion: z.number().int().min(0).max(UINT32_MAX),
}).strict();

export const pactumStateProofSchema = z.object({
  version: z.literal('1.0.0'),
  networkPassphrase: z.string().min(1, 'networkPassphrase is required'),
  ledgerSeq: z.number().int().min(1).max(UINT32_MAX, 'ledgerSeq must be within uint32 range'),
  ledgerHeaderHash: z.string().regex(hex32Regex, 'ledgerHeaderHash must be a 32-byte hex string'),
  stateRootHash: z.string().regex(hex32Regex, 'stateRootHash must be a 32-byte hex string'),
  contractId: z.string().min(1, 'contractId is required'),
  stellarAddress: z.string().min(1, 'stellarAddress is required'),
  scoreData: scoreDataSchema,
  leafHash: z.string().regex(hex32Regex, 'leafHash must be a 32-byte hex string'),
  merkleProof: z.array(merkleProofNodeSchema).max(64),
  headerProof: headerProofSchema,
}).strict();

export const BATCH_PROOF_VERSION = '1.1.0' as const;

export const commitmentEnvelopeSchema = z.object({
  sequenceId: z.number().int().min(0),
  stellarAddress: z.string().min(1),
  scoreData: scoreDataSchema,
  leafHash: z.string().regex(hex32Regex, 'leafHash must be a 32-byte hex string'),
  contractId: z.string().min(1),
}).strict();

export const batchedProofEntrySchema = z.object({
  sequenceId: z.number().int().min(0),
  stellarAddress: z.string().min(1),
  scoreData: scoreDataSchema,
  leafHash: z.string().regex(hex32Regex, 'leafHash must be a 32-byte hex string'),
  merkleProof: z.array(merkleProofNodeSchema).max(64),
  aggregationProof: z.array(merkleProofNodeSchema).max(64),
}).strict();

export const pactumBatchedStateProofSchema = z.object({
  version: z.literal(BATCH_PROOF_VERSION),
  networkPassphrase: z.string().min(1, 'networkPassphrase is required'),
  ledgerSeq: z.number().int().min(1).max(UINT32_MAX, 'ledgerSeq must be within uint32 range'),
  ledgerHeaderHash: z.string().regex(hex32Regex, 'ledgerHeaderHash must be a 32-byte hex string'),
  stateRootHash: z.string().regex(hex32Regex, 'stateRootHash must be a 32-byte hex string'),
  contractId: z.string().min(1, 'contractId is required'),
  aggregationRoot: z.string().regex(hex32Regex, 'aggregationRoot must be a 32-byte hex string'),
  headerProof: headerProofSchema,
  entries: z.array(batchedProofEntrySchema).min(1).max(128),
}).strict();

export type ScoreData = z.infer<typeof scoreDataSchema>;
export type MerkleProofNode = z.infer<typeof merkleProofNodeSchema>;
export type HeaderProof = z.infer<typeof headerProofSchema>;
export type PactumStateProof = z.infer<typeof pactumStateProofSchema>;
export type CommitmentEnvelope = z.infer<typeof commitmentEnvelopeSchema>;
export type BatchedProofEntry = z.infer<typeof batchedProofEntrySchema>;
export type PactumBatchedStateProof = z.infer<typeof pactumBatchedStateProofSchema>;

export interface VerificationResult {
  valid: boolean;
  score?: number;
  ledgerSeq?: number;
  stellarAddress?: string;
  contractId?: string;
  error?: string;
}

export interface BatchVerificationResult {
  valid: boolean;
  scores?: number[];
  ledgerSeq?: number;
  aggregationRoot?: string;
  entryCount?: number;
  error?: string;
}
