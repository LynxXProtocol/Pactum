import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../context/WalletContext';
import { Wallet, X, Check, Copy, Shield, LogOut, AlertTriangle, ExternalLink, Usb } from 'lucide-react';
import { truncateAddress, FREIGHTER_HOMEPAGE } from '../lib/wallet';

export interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WalletConnectModal: React.FC<WalletConnectModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const {
    address,
    provider,
    isConnected,
    isConnecting,
    connectWallet,
    disconnectWallet,
    error,
    errorCode,
  } = useWallet();
  const [copied, setCopied] = React.useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleConnect = async (wallet: 'freighter' | 'albedo' | 'ledger') => {
    await connectWallet(wallet);
  };

  const providerLabel = provider === 'albedo' ? 'Albedo' : provider === 'ledger' ? 'Ledger' : 'Freighter';

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        zIndex: 1000,
        width: '360px',
        background: '#ffffff',
        border: '1.5px solid #e2e8f0',
        borderRadius: '18px',
        padding: '20px',
        boxShadow: '0 16px 36px -6px rgba(15, 23, 42, 0.16), 0 4px 12px rgba(0,0,0,0.04)',
        textAlign: 'left',
        transformOrigin: 'top right',
        animation: 'slideDown 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '14px',
          paddingBottom: '12px',
          borderBottom: '1px solid #f1f5f9',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            fontWeight: '800',
            color: '#6366f1',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          <Wallet size={13} />
          {t('wallet.stellarWallet')}
        </div>

        <button
          onClick={onClose}
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '50%',
            width: '26px',
            height: '26px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            cursor: 'pointer',
          }}
          title={t('wallet.close')}
        >
          <X size={14} />
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            background: errorCode === 'NETWORK_MISMATCH' ? '#fffbeb' : '#fef2f2',
            border: `1px solid ${errorCode === 'NETWORK_MISMATCH' ? '#fde68a' : '#fecaca'}`,
            color: errorCode === 'NETWORK_MISMATCH' ? '#92400e' : '#b91c1c',
            borderRadius: '10px',
            padding: '10px 12px',
            marginBottom: '14px',
            fontSize: '11.5px',
            lineHeight: '1.5',
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
          <div>
            <div style={{ fontWeight: '800', marginBottom: '2px' }}>
              {errorCode === 'NETWORK_MISMATCH' ? t('wallet.wrongNetwork') : t('error.connectionFailed')}
            </div>
            <div>{error}</div>
            {errorCode === 'NETWORK_MISMATCH' && (
              <a
                href="https://freighter.app/settings"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  marginTop: '6px',
                  fontWeight: '700',
                  color: '#92400e',
                  textDecoration: 'underline',
                }}
              >
                {t('wallet.switchToTestnet')} <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Connected View */}
      {isConnected && address ? (
        <div>
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '14px',
              padding: '14px',
              marginBottom: '14px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}
            >
              <span
                style={{
                  fontSize: '10.5px',
                  fontWeight: '800',
                  color: '#16a34a',
                  background: '#dcfce7',
                  padding: '2px 8px',
                  borderRadius: '100px',
                  border: '1px solid #bbf7d0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span
                  style={{
                    width: '5px',
                    height: '5px',
                    borderRadius: '50%',
                    background: '#22c55e',
                  }}
                ></span>
                {providerLabel} · {t('app.nav.network')}
              </span>
              <button
                onClick={handleCopy}
                style={{
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  padding: '3px 8px',
                  fontSize: '11px',
                  color: '#334155',
                  cursor: 'pointer',
                  fontWeight: '700',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {copied ? <Check size={11} color="#16a34a" /> : <Copy size={11} />}
                {copied ? t('wallet.copied') : t('wallet.copy')}
              </button>
            </div>

            <div
              style={{
                fontFamily: 'monospace',
                fontSize: '13.5px',
                fontWeight: '800',
                color: '#0f172a',
                wordBreak: 'break-all',
              }}
            >
              {truncateAddress(address, 8, 8)}
            </div>
          </div>

          <button
            onClick={() => {
              disconnectWallet();
              onClose();
            }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              background: '#ffffff',
              border: '1px solid #fecdd3',
              color: '#be123c',
              fontSize: '12.5px',
              fontWeight: '700',
              padding: '9px',
              borderRadius: '10px',
              cursor: 'pointer',
            }}
          >
            <LogOut size={13} />
            {t('wallet.disconnect')}
          </button>
        </div>
      ) : (
        /* Disconnected State: Wallet Provider Options */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={() => handleConnect('freighter')}
            disabled={isConnecting}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              background: '#ffffff',
              border: '1.5px solid #6366f1',
              borderRadius: '14px',
              cursor: isConnecting ? 'wait' : 'pointer',
              boxShadow: '0 2px 8px rgba(99, 102, 241, 0.08)',
              transition: 'all 0.15s ease',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Wallet size={18} />
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>
                  {t('wallet.freighterWallet')}
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  {t('wallet.officialStellarExtension')}
                </div>
              </div>
            </div>

            <span style={{ fontSize: '12.5px', fontWeight: '800', color: '#6366f1' }}>
              {isConnecting ? '...' : 'Connect →'}
            </span>
          </button>

          <button
            onClick={() => handleConnect('albedo')}
            disabled={isConnecting}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              background: '#ffffff',
              border: '1.5px solid #e2e8f0',
              borderRadius: '14px',
              cursor: isConnecting ? 'wait' : 'pointer',
              transition: 'all 0.15s ease',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, #0f172a 0%, #334155 100%)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Shield size={18} />
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>
                  {t('wallet.albedoWallet')}
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  {t('wallet.albedoDescription')}
                </div>
              </div>
            </div>

            <span style={{ fontSize: '12.5px', fontWeight: '800', color: '#334155' }}>
              {isConnecting ? '...' : 'Connect →'}
            </span>
          </button>

          <button
            onClick={() => handleConnect('ledger')}
            disabled={isConnecting}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              background: '#ffffff',
              border: '1.5px solid #e2e8f0',
              borderRadius: '14px',
              cursor: isConnecting ? 'wait' : 'pointer',
              transition: 'all 0.15s ease',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, #000000 0%, #334155 100%)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Usb size={18} />
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>
                  {t('wallet.ledgerNano')}
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  {t('wallet.ledgerDescription')}
                </div>
              </div>
            </div>

            <span style={{ fontSize: '12.5px', fontWeight: '800', color: '#334155' }}>
              {isConnecting ? '...' : 'Connect →'}
            </span>
          </button>

          {errorCode === 'NOT_INSTALLED' && (
            <a
              href={FREIGHTER_HOMEPAGE}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                background: '#0f172a',
                color: '#ffffff',
                fontWeight: '700',
                fontSize: '12px',
                padding: '10px',
                borderRadius: '10px',
                textDecoration: 'none',
              }}
            >
              <ExternalLink size={13} />
              {t('wallet.installFreighter')}
            </a>
          )}

          <div
            style={{
              textAlign: 'center',
              fontSize: '11px',
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
            }}
          >
            <Shield size={11} />
            {t('wallet.nonCustodialSecurity')}
          </div>
        </div>
      )}
    </div>
  );
};

export default WalletConnectModal;
