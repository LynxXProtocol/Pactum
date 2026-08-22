export type CommitmentStatus = 'Pending' | 'Fulfilled' | 'Late' | 'Breached' | 'Disputed';

export interface Reputation {
  address: string;
  fulfilled: number;
  late: number;
  breached: number;
  total: number;
}

export interface Commitment {
  id: number;
  issuer: string;
  counterparty: string;
  terms_hash: string;
  due_at: number;
  status: CommitmentStatus;
  outcome: CommitmentStatus | null;
  created_at?: number;
  attested_at?: number | null;
  /** True when the terms are stored as AES-GCM ciphertext on the backend. */
  encrypted?: boolean;
}

export interface CommitmentFilters {
  status?: CommitmentStatus;
  address?: string;
  page?: number;
  limit?: number;
}

export interface CommitmentsResponse {
  items: Commitment[];
  total?: number;
  page?: number;
  limit?: number;
}

export interface ScoreData {
  score: number;
  fulfilledCount: number;
  lateCount: number;
  breachedCount: number;
  epoch: number;
  sourceLedgerSeq: number;
}

export interface PactumStateProof {
  version: string;
  networkPassphrase: string;
  ledgerSeq: number;
  ledgerHeaderHash: string;
  stateRootHash: string;
  contractId: string;
  stellarAddress: string;
  scoreData: ScoreData;
  leafHash: string;
  merkleProof: Array<{ sibling: string; isRight: boolean }>;
  headerProof: {
    previousLedgerHash: string;
    txSetResultHash: string;
    bucketListHash: string;
    ledgerVersion: number;
  };
}

interface StateProofResponse {
  success: true;
  proof: PactumStateProof;
}

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, options);

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export function fetchReputation(address: string, signal?: AbortSignal): Promise<Reputation> {
  return request<Reputation>(`/reputation/${encodeURIComponent(address)}`, { signal });
}

export async function fetchReputationProof(
  address: string,
  signal?: AbortSignal,
): Promise<PactumStateProof> {
  const response = await request<StateProofResponse>(
    `/api/v1/proofs/trust-score/${encodeURIComponent(address)}`,
    { signal },
  );

  if (!response.success || !response.proof) {
    throw new Error('State proof response is missing its proof payload');
  }

  return response.proof;
}

export async function fetchCommitments(
  filters: CommitmentFilters = {},
  signal?: AbortSignal,
): Promise<Commitment[]> {
  const params = new URLSearchParams();

  if (filters.status) params.set('status', filters.status);
  if (filters.address) params.set('address', filters.address);
  if (filters.page) params.set('page', filters.page.toString());
  if (filters.limit) params.set('limit', filters.limit.toString());

  const query = params.toString();
  const res = await request<Commitment[] | CommitmentsResponse>(`/commitments${query ? `?${query}` : ''}`, { signal });
  if (Array.isArray(res)) {
    return res;
  }
  return res?.items ?? [];
}

/**
 * Creates a commitment record on the backend (optimistic, before on-chain confirmation).
 */
export function createCommitment(payload: {
  issuer: string;
  counterparty: string;
  termsHash: string;
  dueAt: number;
}): Promise<{ id: number; status: string }> {
  return request<{ id: number; status: string }>('/commitments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      issuer: payload.issuer,
      counterparty: payload.counterparty,
      terms_hash: payload.termsHash,
      due_at: payload.dueAt,
    }),
  });
}

// ── Encrypted Terms API ──────────────────────────────────────────────────────

export interface EncryptedTermsPayload {
  commitmentId: string;
  issuer: string;
  counterparty: string;
  /** base64url(IV || AES-GCM ciphertext || auth-tag) — never plaintext */
  ciphertext: string;
}

export interface EncryptedTermsResponse {
  ciphertext: string;
  issuer: string;
  counterparty: string;
  createdAt: string;
}

/**
 * Stores an AES-GCM ciphertext blob on the backend for a confirmed commitment.
 * The backend never receives plaintext — only an opaque encrypted blob.
 */
export function postEncryptedTerms(payload: EncryptedTermsPayload): Promise<{ message: string }> {
  return request<{ message: string }>('/commitments/encrypted', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Fetches the ciphertext blob for a commitment. Decryption happens in the browser.
 *
 * @param commitmentId - The on-chain commitment ID (number as string).
 */
export function fetchEncryptedTerms(
  commitmentId: string,
  signal?: AbortSignal,
): Promise<EncryptedTermsResponse> {
  return request<EncryptedTermsResponse>(
    `/commitments/${encodeURIComponent(commitmentId)}/encrypted`,
    { signal },
  );
}
