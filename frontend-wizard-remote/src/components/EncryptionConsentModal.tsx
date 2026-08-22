import { useState } from 'react';
import { Lock, ShieldCheck, KeyRound, AlertTriangle, Loader2, X } from 'lucide-react';

export type EncryptionConsentState = 'idle' | 'signing' | 'encrypting' | 'done' | 'error';

interface EncryptionConsentModalProps {
  /** Called when the user clicks "Sign to Encrypt" — caller runs the crypto pipeline */
  onConfirm: () => Promise<void>;
  /** Called when the user dismisses the modal (cancels encryption) */
  onCancel: () => void;
  issuerAddress: string;
  counterpartyAddress: string;
  /** Whether the connected provider is Freighter (only Freighter supports signMessage) */
  isFreighter: boolean;
}

export default function EncryptionConsentModal({
  onConfirm,
  onCancel,
  issuerAddress,
  counterpartyAddress,
  isFreighter,
}: EncryptionConsentModalProps) {
  const [state, setState] = useState<EncryptionConsentState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const truncate = (addr: string) =>
    addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;

  const handleConfirm = async () => {
    setState('signing');
    setErrorMessage(null);
    try {
      await onConfirm();
      setState('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Encryption failed. Please try again.';
      setErrorMessage(msg);
      setState('error');
    }
  };

  return (
    /* Backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="encrypt-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        background: 'rgba(2, 6, 23, 0.72)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && state === 'idle') onCancel();
      }}
    >
      {/* Panel */}
      <div
        style={{
          background: '#ffffff',
          borderRadius: '20px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.28)',
          width: '100%',
          maxWidth: '460px',
          overflow: 'hidden',
          animation: 'slideUp 0.22s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            background: 'linear-gradient(135deg, #312e81 0%, #4338ca 60%, #6366f1 100%)',
            padding: '24px 24px 20px 24px',
            position: 'relative',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={state === 'signing' || state === 'encrypting'}
            aria-label="Cancel encryption"
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              width: '30px',
              height: '30px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              opacity: state === 'signing' || state === 'encrypting' ? 0.4 : 1,
            }}
          >
            <X size={15} />
          </button>

          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '14px',
              background: 'rgba(255,255,255,0.18)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '14px',
            }}
          >
            <Lock size={24} color="#ffffff" />
          </div>

          <h2
            id="encrypt-modal-title"
            style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#ffffff' }}
          >
            Encrypt Commitment Terms
          </h2>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.75)' }}>
            End-to-end encrypted — only you and the counterparty can read the terms.
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px' }}>
          {!isFreighter ? (
            /* Albedo warning */
            <div
              style={{
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: '12px',
                padding: '14px',
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
              }}
            >
              <AlertTriangle size={18} color="#d97706" style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: '700', color: '#92400e' }}>
                  Freighter Required for Encryption
                </div>
                <div style={{ fontSize: '12px', color: '#78350f', marginTop: '4px' }}>
                  Albedo does not currently support the raw message signing API needed for
                  key derivation. Please switch to Freighter to use encrypted commitments.
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* How it works */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
                {[
                  {
                    icon: <KeyRound size={15} color="#6366f1" />,
                    title: 'Wallet signature → encryption key',
                    desc: 'Freighter will sign a non-transaction message to deterministically derive an AES-256 key. No XLM is spent.',
                  },
                  {
                    icon: <Lock size={15} color="#6366f1" />,
                    title: 'Encrypted locally in your browser',
                    desc: 'The terms are encrypted before leaving your device. The backend stores only an opaque blob — never plaintext.',
                  },
                  {
                    icon: <ShieldCheck size={15} color="#6366f1" />,
                    title: 'Counterparty decrypts with their key',
                    desc: `Only ${truncate(counterpartyAddress)} can decrypt — they derive the same key from their Freighter wallet.`,
                  },
                ].map(({ icon, title, desc }) => (
                  <div
                    key={title}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      padding: '10px 12px',
                      background: '#f8faff',
                      borderRadius: '10px',
                      border: '1px solid #e0e7ff',
                    }}
                  >
                    <div
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '8px',
                        background: '#eef2ff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {icon}
                    </div>
                    <div>
                      <div style={{ fontSize: '12.5px', fontWeight: '700', color: '#1e1b4b' }}>
                        {title}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#6b7280', marginTop: '2px' }}>
                        {desc}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Parties */}
              <div
                style={{
                  background: '#f1f5f9',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  fontSize: '11.5px',
                  color: '#475569',
                  marginBottom: '18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div>
                  <span style={{ fontWeight: '600', color: '#334155' }}>Issuer (you): </span>
                  <span style={{ fontFamily: 'monospace' }}>{truncate(issuerAddress)}</span>
                </div>
                <div>
                  <span style={{ fontWeight: '600', color: '#334155' }}>Counterparty: </span>
                  <span style={{ fontFamily: 'monospace' }}>{truncate(counterpartyAddress)}</span>
                </div>
              </div>

              {/* Status / error */}
              {state === 'signing' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    marginBottom: '14px',
                    fontSize: '12.5px',
                    color: '#1d4ed8',
                    fontWeight: '600',
                  }}
                >
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  Awaiting signature in Freighter…
                </div>
              )}

              {state === 'encrypting' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    marginBottom: '14px',
                    fontSize: '12.5px',
                    color: '#1d4ed8',
                    fontWeight: '600',
                  }}
                >
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  Encrypting terms locally…
                </div>
              )}

              {state === 'error' && errorMessage && (
                <div
                  style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    marginBottom: '14px',
                    fontSize: '12px',
                    color: '#b91c1c',
                    fontWeight: '600',
                  }}
                >
                  {errorMessage}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {isFreighter && (
          <div
            style={{
              padding: '0 24px 24px 24px',
              display: 'flex',
              gap: '10px',
            }}
          >
            <button
              type="button"
              id="encrypt-modal-cancel"
              onClick={onCancel}
              disabled={state === 'signing' || state === 'encrypting'}
              style={{
                flex: 1,
                padding: '11px',
                borderRadius: '10px',
                border: '1px solid #e2e8f0',
                background: '#ffffff',
                color: '#334155',
                fontWeight: '700',
                fontSize: '13px',
                cursor: 'pointer',
                opacity: state === 'signing' || state === 'encrypting' ? 0.5 : 1,
              }}
            >
              Cancel
            </button>

            <button
              type="button"
              id="encrypt-modal-confirm"
              onClick={handleConfirm}
              disabled={state === 'signing' || state === 'encrypting' || state === 'done'}
              style={{
                flex: 2,
                padding: '11px',
                borderRadius: '10px',
                border: 'none',
                background:
                  state === 'done'
                    ? '#16a34a'
                    : state === 'error'
                    ? '#dc2626'
                    : 'linear-gradient(135deg, #4338ca, #6366f1)',
                color: '#ffffff',
                fontWeight: '800',
                fontSize: '13px',
                cursor:
                  state === 'signing' || state === 'encrypting' || state === 'done'
                    ? 'not-allowed'
                    : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '7px',
                opacity: state === 'signing' || state === 'encrypting' ? 0.7 : 1,
                transition: 'background 0.2s',
              }}
            >
              {state === 'signing' || state === 'encrypting' ? (
                <>
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  {state === 'signing' ? 'Waiting for signature…' : 'Encrypting…'}
                </>
              ) : state === 'done' ? (
                <>✓ Encrypted</>
              ) : state === 'error' ? (
                <>Retry</>
              ) : (
                <>
                  <Lock size={14} />
                  Sign to Encrypt
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
