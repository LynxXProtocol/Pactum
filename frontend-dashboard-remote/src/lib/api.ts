export type CommitmentStatus = 'Pending' | 'Fulfilled' | 'Late' | 'Breached';

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
  /** True when the terms are stored as AES-GCM ciphertext on the backend. */
  encrypted?: boolean;
}

export interface CommitmentFilters {
  status?: CommitmentStatus;
  address?: string;
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

export function fetchCommitments(
  filters: CommitmentFilters = {},
  signal?: AbortSignal,
): Promise<Commitment[]> {
  const params = new URLSearchParams();

  if (filters.status) params.set('status', filters.status);
  if (filters.address) params.set('address', filters.address);
  if (filters.page) params.set('page', filters.page.toString());
  if (filters.limit) params.set('limit', filters.limit.toString());

  const query = params.toString();
  return request<Commitment[]>(`/commitments${query ? `?${query}` : ''}`, { signal });
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

// ── Export API ───────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'pdf';

/**
 * Triggers a file download for a commitment-history export.
 *
 * Fetches `GET /commitments/export/:address?format=csv|pdf`, converts the
 * response to a Blob, and programmatically clicks a temporary anchor so the
 * browser saves the file. No library dependency — works in all modern browsers.
 *
 * @param address - Stellar public key to export history for.
 * @param format  - 'csv' or 'pdf' (defaults to 'csv').
 * @param signal  - Optional AbortSignal to cancel the request.
 */
export async function exportCommitments(
  address: string,
  format: ExportFormat = 'csv',
  signal?: AbortSignal,
): Promise<void> {
  const url = `${API_BASE_URL}/commitments/export/${encodeURIComponent(address)}?format=${format}`;

  const res = await fetch(url, { signal });

  if (!res.ok) {
    throw new Error(`Export failed: ${res.status} ${res.statusText}`);
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `pactum-history-${address}.${format}`;
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoke the object URL after a short delay to let the download start
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
}
