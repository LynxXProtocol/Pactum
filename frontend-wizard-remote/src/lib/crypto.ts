/**
 * Pactum E2E Encryption — Browser-only crypto primitives
 *
 * Strategy: Sign-to-Derive (deterministic Diffie-Hellman substitute)
 * 1. Build a deterministic payload from both party addresses.
 * 2. Issuer signs with Freighter → Ed25519 signature (64 bytes, deterministic).
 * 3. Signature → HKDF-SHA256 → AES-GCM-256 key.
 * 4. Encrypt plaintext terms → base64(IV ‖ ciphertext ‖ auth-tag).
 *
 * Counterparty signs the same payload → same key → decrypt locally.
 * Backend stores only the opaque ciphertext blob.
 *
 * All operations use the Web Crypto API (SubtleCrypto) — zero npm deps.
 */

import { signMessage as freighterSignMessage } from '@stellar/freighter-api';

// ── Constants ─────────────────────────────────────────────────────────────────

const PACTUM_ENCRYPT_PREFIX = 'PACTUM_ENCRYPT_V1';
const HKDF_INFO = new TextEncoder().encode('pactum-terms-encryption-v1');
const HKDF_SALT_STR = 'pactum-deterministic-salt-2025';

// ── Signing Payload ───────────────────────────────────────────────────────────

/**
 * Builds the deterministic message that both parties must sign to derive the
 * shared encryption key. Using a date prefix scopes the key to a calendar day
 * and keeps the payload human-readable in the Freighter popup.
 *
 * Format: `PACTUM_ENCRYPT_V1:<sortedAddress1>:<sortedAddress2>`
 *
 * Addresses are sorted lexicographically so the payload is identical
 * regardless of which party is the issuer.
 */
export function buildSigningPayload(issuerAddress: string, counterpartyAddress: string): string {
  const [a, b] = [issuerAddress.trim(), counterpartyAddress.trim()].sort();
  return `${PACTUM_ENCRYPT_PREFIX}:${a}:${b}`;
}

// ── Key Derivation ────────────────────────────────────────────────────────────

/**
 * Derives an AES-GCM-256 CryptoKey from a raw Ed25519 signature using HKDF-SHA256.
 *
 * @param signatureBytes - Raw 64-byte Ed25519 signature from Freighter `signMessage`.
 * @returns A non-extractable AES-GCM CryptoKey for encrypt/decrypt operations.
 */
export async function deriveEncryptionKey(signatureBytes: Uint8Array): Promise<CryptoKey> {
  // Import the raw signature bytes as HKDF keying material
  // Ensure we have a plain ArrayBuffer (no SharedArrayBuffer) for SubtleCrypto
  const rawBuffer = signatureBytes.buffer.slice(
    signatureBytes.byteOffset,
    signatureBytes.byteOffset + signatureBytes.byteLength,
  ) as ArrayBuffer;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    rawBuffer,
    { name: 'HKDF' },
    false, // non-extractable
    ['deriveKey'],
  );

  const salt = new TextEncoder().encode(HKDF_SALT_STR);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: HKDF_INFO,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

// ── Encryption ────────────────────────────────────────────────────────────────

/**
 * Encrypts plaintext using AES-GCM-256.
 *
 * Output format: `base64url(IV[12] ‖ ciphertext ‖ auth-tag[16])`
 * The IV is randomly generated per encryption; auth-tag is appended by SubtleCrypto.
 *
 * @param key      - AES-GCM CryptoKey (from `deriveEncryptionKey`).
 * @param plaintext - UTF-8 text to encrypt.
 * @returns Base64url-encoded opaque ciphertext blob.
 */
export async function encryptTerms(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // Prepend IV: IV(12) || ciphertext+auth-tag
  const combined = new Uint8Array(12 + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), 12);

  return uint8ArrayToBase64url(combined);
}

// ── Decryption ────────────────────────────────────────────────────────────────

/**
 * Decrypts a ciphertext blob produced by `encryptTerms`.
 *
 * @param key        - AES-GCM CryptoKey (re-derived by counterparty).
 * @param ciphertext - Base64url blob from the backend.
 * @returns Decrypted UTF-8 plaintext.
 * @throws If the key is wrong or the ciphertext is tampered (AES-GCM auth failure).
 */
export async function decryptTerms(key: CryptoKey, ciphertext: string): Promise<string> {
  const combined = base64urlToUint8Array(ciphertext);

  if (combined.length < 13) {
    throw new Error('Ciphertext blob is too short to be valid.');
  }

  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(plainBuf);
}

// ── Freighter Integration ─────────────────────────────────────────────────────

export interface SignPayloadResult {
  signatureBytes: Uint8Array;
  signerAddress: string;
}

/**
 * Prompts the user to sign a deterministic payload via Freighter `signMessage`.
 * This triggers a Freighter popup (not a transaction signature — no XLM involved).
 *
 * @param payload - The deterministic string built by `buildSigningPayload`.
 * @param address - Signer's Stellar address (G...).
 * @returns Raw signature bytes for use in `deriveEncryptionKey`.
 * @throws If Freighter rejects the sign request or the response is malformed.
 */
export async function signPayloadWithFreighter(
  payload: string,
  address: string,
): Promise<SignPayloadResult> {
  const result = await freighterSignMessage(payload, { address });

  if (result.error) {
    throw new Error(
      `Freighter rejected the signing request: ${(result.error as any)?.message ?? String(result.error)}`,
    );
  }

  if (!result.signedMessage) {
    throw new Error('Freighter returned an empty signature. Please try again.');
  }

  // signedMessage is Buffer (v3) or string (v4 base64) — handle both
  let bytes: Uint8Array;
  if (typeof result.signedMessage === 'string') {
    // v4: base64-encoded string
    bytes = base64ToUint8Array(result.signedMessage);
  } else if (
    result.signedMessage !== null &&
    typeof result.signedMessage === 'object' &&
    'byteLength' in result.signedMessage
  ) {
    // v3: Buffer-like object (treated as ArrayBuffer view)
    const buf = result.signedMessage as { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    bytes = new Uint8Array(ab);
  } else {
    throw new Error('Freighter signedMessage is in an unexpected format.');
  }

  if (bytes.length === 0) {
    throw new Error('Freighter returned zero-length signature bytes.');
  }

  return { signatureBytes: bytes, signerAddress: result.signerAddress };
}

// ── Convenience: Full Encrypt Pipeline ───────────────────────────────────────

export interface EncryptResult {
  ciphertext: string;     // base64url blob for backend storage
  termsHash: string;      // hex SHA-256(ciphertext) — goes on-chain
}

/**
 * Full encryption pipeline:
 * 1. Build deterministic signing payload.
 * 2. Prompt Freighter to sign it.
 * 3. Derive AES-GCM key from signature.
 * 4. Encrypt the plaintext terms.
 * 5. Hash the ciphertext (not plaintext) for on-chain commitment.
 *
 * @param plaintext          - Raw terms string from the form.
 * @param issuerAddress      - Connected wallet address.
 * @param counterpartyAddress - Target counterparty address.
 * @param onStatus           - Optional callback for progress messages.
 */
export async function encryptCommitmentTerms(
  plaintext: string,
  issuerAddress: string,
  counterpartyAddress: string,
  onStatus?: (msg: string) => void,
): Promise<EncryptResult> {
  onStatus?.('Building signing payload...');
  const payload = buildSigningPayload(issuerAddress, counterpartyAddress);

  onStatus?.('Requesting signature in Freighter to derive encryption key...');
  const { signatureBytes } = await signPayloadWithFreighter(payload, issuerAddress);

  onStatus?.('Deriving encryption key...');
  const key = await deriveEncryptionKey(signatureBytes);

  onStatus?.('Encrypting terms locally...');
  const ciphertext = await encryptTerms(key, plaintext);

  onStatus?.('Computing on-chain commitment hash...');
  const termsHash = await sha256Hex(ciphertext);

  return { ciphertext, termsHash };
}

/**
 * Full decryption pipeline (counterparty side):
 * 1. Build the same deterministic signing payload.
 * 2. Prompt Freighter to sign it (counterparty's key).
 * 3. Derive AES-GCM key from signature.
 * 4. Decrypt the ciphertext.
 *
 * @param ciphertext          - base64url blob fetched from backend.
 * @param issuerAddress       - Original issuer's address.
 * @param counterpartyAddress - Viewer's (counterparty's) address.
 * @param viewerAddress       - The currently connected wallet address (either party).
 * @param onStatus            - Optional callback for progress messages.
 */
export async function decryptCommitmentTerms(
  ciphertext: string,
  issuerAddress: string,
  counterpartyAddress: string,
  viewerAddress: string,
  onStatus?: (msg: string) => void,
): Promise<string> {
  onStatus?.('Building signing payload...');
  const payload = buildSigningPayload(issuerAddress, counterpartyAddress);

  onStatus?.('Requesting signature in Freighter to re-derive encryption key...');
  const { signatureBytes } = await signPayloadWithFreighter(payload, viewerAddress);

  onStatus?.('Deriving decryption key...');
  const key = await deriveEncryptionKey(signatureBytes);

  onStatus?.('Decrypting terms locally...');
  return decryptTerms(key, ciphertext);
}

// ── Internal Utilities ────────────────────────────────────────────────────────

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToUint8Array(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToUint8Array(b64: string): Uint8Array {
  // Handle both regular base64 and base64url
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
