import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Unlock, ShieldCheck, Loader2, X, AlertTriangle, Eye } from 'lucide-react';
import { decryptCommitmentTerms } from '../lib/crypto';

export type DecryptState = 'idle' | 'signing' | 'decrypting' | 'revealed' | 'error';

interface DecryptTermsModalProps {
  commitmentId: number | string;
  /** AES-GCM ciphertext blob fetched from backend */
  ciphertext: string;
  issuerAddress: string;
  counterpartyAddress: string;
  /** The currently connected wallet address (must be issuer or counterparty) */
  viewerAddress: string;
  /** True if viewer is connected via Freighter (required for signMessage) */
  isFreighter: boolean;
  onClose: () => void;
}

export default function DecryptTermsModal({
  commitmentId,
  ciphertext,
  issuerAddress,
  counterpartyAddress,
  viewerAddress,
  isFreighter,
  onClose,
}: DecryptTermsModalProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<DecryptState>('idle');
  const [decryptedText, setDecryptedText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const truncate = (addr: string) =>
    addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;

  // Check if viewer is one of the two parties
  const isParty =
    viewerAddress.trim().toUpperCase() === issuerAddress.trim().toUpperCase() ||
    viewerAddress.trim().toUpperCase() === counterpartyAddress.trim().toUpperCase();

  const handleDecrypt = async () => {
    if (!isParty || !isFreighter) return;

    setState('signing');
    setErrorMessage(null);
    setStatusMsg(null);

    try {
      const plaintext = await decryptCommitmentTerms(
        ciphertext,
        issuerAddress,
        counterpartyAddress,
        viewerAddress,
        (msg) => {
          if (msg.includes('sign')) setState('signing');
          else if (msg.includes('Decrypt') || msg.includes('deriv')) setState('decrypting');
          setStatusMsg(msg);
        },
      );

      setDecryptedText(plaintext);
      setState('revealed');
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Decryption failed. Make sure you are connected with the correct wallet.';
      setErrorMessage(msg);
      setState('error');
    }
  };

  return (
    /* Backdrop */
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="decrypt-modal-title"
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
        if (e.target === e.currentTarget && state !== 'signing' && state !== 'decrypting') {
          onClose();
        }
      }}
    >
      {/* Panel */}
      <div
        style={{
          background: '#ffffff',
          borderRadius: '20px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.28)',
          width: '100%',
          maxWidth: '480px',
          overflow: 'hidden',
          animation: 'slideUp 0.22s cubic-bezier(0.34,1.56,0.64,1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            background:
              state === 'revealed'
                ? 'linear-gradient(135deg, #14532d 0%, #15803d 60%, #22c55e 100%)'
                : 'linear-gradient(135deg, #1e1b4b 0%, #312e81 60%, #4338ca 100%)',
            padding: '24px 24px 20px 24px',
            position: 'relative',
            transition: 'background 0.4s',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={state === 'signing' || state === 'decrypting'}
            aria-label={t('wallet.closeDecrypt')}
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
              opacity: state === 'signing' || state === 'decrypting' ? 0.4 : 1,
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
            {state === 'revealed' ? (
              <Unlock size={24} color="#ffffff" />
            ) : (
              <Lock size={24} color="#ffffff" />
            )}
          </div>

          <h2
            id="decrypt-modal-title"
            style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#ffffff' }}
          >
            {state === 'revealed' ? t('decrypt.decrypted') : t('decrypt.title')}
          </h2>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.75)' }}>
            {state === 'revealed'
              ? t('wizard.encryption.decryptedLocally')
              : t('decrypt.signPrompt', { id: commitmentId })}
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px 24px 24px' }}>

          {/* Not-a-party warning */}
          {!isParty && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '12px',
                padding: '14px',
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                marginBottom: '16px',
              }}
            >
              <AlertTriangle size={18} color="#dc2626" style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: '700', color: '#991b1b' }}>
                  {t('decrypt.accessDenied')}
                </div>
                <div style={{ fontSize: '12px', color: '#7f1d1d', marginTop: '4px' }}>
                  {t('decrypt.notParty', { address: truncate(viewerAddress) })}
                </div>
                </div>
              </div>
            </div>
          )}

          {/* Not Freighter warning */}
          {isParty && !isFreighter && (
            <div
              style={{
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: '12px',
                padding: '14px',
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                marginBottom: '16px',
              }}
            >
              <AlertTriangle size={18} color="#d97706" style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: '700', color: '#92400e' }}>
                  {t('decrypt.freighterRequired')}
                </div>
                <div style={{ fontSize: '12px', color: '#78350f', marginTop: '4px' }}>
                  {t('decrypt.needsFreighter')}
                </div>
                </div>
              </div>
            </div>
          )}

          {/* Parties */}
          {isParty && state !== 'revealed' && (
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '11.5px',
                color: '#475569',
                marginBottom: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div>
                <span style={{ fontWeight: '600', color: '#334155' }}>{t('decrypt.issuer')} </span>
                <span style={{ fontFamily: 'monospace' }}>{truncate(issuerAddress)}</span>
              </div>
              <div>
                <span style={{ fontWeight: '600', color: '#334155' }}>{t('decrypt.counterparty')} </span>
                <span style={{ fontFamily: 'monospace' }}>{truncate(counterpartyAddress)}</span>
              </div>
              <div>
                <span style={{ fontWeight: '600', color: '#334155' }}>{t('decrypt.yourWallet')} </span>
                <span style={{ fontFamily: 'monospace' }}>{truncate(viewerAddress)}</span>
                <span
                  style={{
                    marginLeft: '6px',
                    fontSize: '10.5px',
                    fontWeight: '700',
                    color: '#16a34a',
                    background: '#dcfce7',
                    padding: '1px 7px',
                    borderRadius: '100px',
                  }}
                >
                  {t('decrypt.authorized')}
                </span>
              </div>
            </div>
          )}

          {/* How it works (idle only) */}
          {isParty && isFreighter && state === 'idle' && (
            <div
              style={{
                background: '#f8faff',
                border: '1px solid #e0e7ff',
                borderRadius: '10px',
                padding: '12px 14px',
                fontSize: '12px',
                color: '#3730a3',
                marginBottom: '16px',
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start',
              }}
            >
              <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>
                {t('decrypt.howItWorks')}
              </span>
            </div>
          )}

          {/* In-flight status */}
          {(state === 'signing' || state === 'decrypting') && statusMsg && (
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
              {statusMsg}
            </div>
          )}

          {/* Error */}
          {state === 'error' && errorMessage && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '10px',
                padding: '12px 14px',
                marginBottom: '14px',
                fontSize: '12px',
                color: '#b91c1c',
                fontWeight: '600',
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* Revealed plaintext */}
          {state === 'revealed' && decryptedText !== null && (
            <div
              style={{
                background: '#f0fdf4',
                border: '2px solid #86efac',
                borderRadius: '12px',
                padding: '16px',
                marginBottom: '16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '11px',
                  fontWeight: '800',
                  color: '#15803d',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: '8px',
                }}
              >
                <Eye size={13} />
                {t('decrypt.decryptedTerms')}
              </div>
              <p
                id="decrypted-terms-text"
                style={{
                  margin: 0,
                  fontSize: '14px',
                  lineHeight: '1.65',
                  color: '#14532d',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {decryptedText}
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '10px' }}>
            {state === 'revealed' ? (
              <button
                type="button"
                id="decrypt-modal-close"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: '11px',
                  borderRadius: '10px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #15803d, #22c55e)',
                  color: '#ffffff',
                  fontWeight: '800',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                {t('decrypt.close')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  id="decrypt-modal-cancel"
                  onClick={onClose}
                  disabled={state === 'signing' || state === 'decrypting'}
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
                    opacity: state === 'signing' || state === 'decrypting' ? 0.5 : 1,
                  }}
                >
                  {t('decrypt.cancel')}
                </button>

                {isParty && isFreighter && (
                  <button
                    type="button"
                    id="decrypt-modal-confirm"
                    onClick={handleDecrypt}
                    disabled={state === 'signing' || state === 'decrypting'}
                    style={{
                      flex: 2,
                      padding: '11px',
                      borderRadius: '10px',
                      border: 'none',
                      background:
                        state === 'error'
                          ? '#dc2626'
                          : 'linear-gradient(135deg, #1e1b4b, #4338ca)',
                      color: '#ffffff',
                      fontWeight: '800',
                      fontSize: '13px',
                      cursor:
                        state === 'signing' || state === 'decrypting' ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '7px',
                      opacity: state === 'signing' || state === 'decrypting' ? 0.7 : 1,
                    }}
                  >
                    {state === 'signing' || state === 'decrypting' ? (
                      <>
                        <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                        {state === 'signing' ? t('decrypt.waitingSignature') : t('decrypt.decrypting')}
                      </>
                    ) : state === 'error' ? (
                      <>{t('decrypt.retryDecrypt')}</>
                    ) : (
                      <>
                        <Unlock size={14} />
                        {t('decrypt.signToDecrypt')}
                      </>
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
