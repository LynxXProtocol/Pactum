import React, { useEffect, useRef } from 'react';
import { useWallet } from '../context/WalletContext';
import {
  Wallet,
  X,
  Check,
  Copy,
  Shield,
  LogOut,
  AlertTriangle,
  ExternalLink,
  Usb,
  Mail,
} from 'lucide-react';
import { truncateAddress, FREIGHTER_HOMEPAGE, type WalletProvider } from '@pactum/soroban-client';

export interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function providerDisplayName(provider: WalletProvider | null): string {
  switch (provider) {
    case 'albedo':
      return 'Albedo';
    case 'ledger':
      return 'Ledger';
    case 'web3auth':
      return 'Social login';
    case 'freighter':
    default:
      return 'Freighter';
  }
}

function isSocialLoginConfigured(): boolean {
  return Boolean(
    typeof import.meta !== 'undefined' &&
    String(import.meta.env?.VITE_WEB3AUTH_CLIENT_ID ?? '').trim(),
  );
}

export const WalletConnectModal: React.FC<WalletConnectModalProps> = ({ isOpen, onClose }) => {
  const {
    address,
    provider,
    isConnected,
    isConnecting,
    isSocialLogin,
    connectWallet,
    disconnectWallet,
    error,
    errorCode,
  } = useWallet();
  const [copied, setCopied] = React.useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const socialConfigured = isSocialLoginConfigured();

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

  const handleConnect = async (wallet: WalletProvider) => {
    await connectWallet(wallet);
  };

  const providerLabel = providerDisplayName(provider);

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: '10px',
    fontWeight: 800,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '8px',
    marginTop: '4px',
  };

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
          {isSocialLogin ? 'Social session' : 'Stellar Wallet'}
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
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

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
              {errorCode === 'NETWORK_MISMATCH' ? 'Wrong network detected' : 'Connection failed'}
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
                Switch Freighter to Testnet <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
      )}

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
                  color: isSocialLogin ? '#0369a1' : '#16a34a',
                  background: isSocialLogin ? '#e0f2fe' : '#dcfce7',
                  padding: '2px 8px',
                  borderRadius: '100px',
                  border: `1px solid ${isSocialLogin ? '#bae6fd' : '#bbf7d0'}`,
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
                    background: isSocialLogin ? '#0ea5e9' : '#22c55e',
                  }}
                />
                {isSocialLogin
                  ? `${providerLabel} · Web2 onboarding`
                  : `${providerLabel} · Stellar Testnet`}
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
                {copied ? 'Copied' : 'Copy'}
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
            {isSocialLogin && (
              <div
                style={{ fontSize: '11px', color: '#64748b', marginTop: '8px', lineHeight: 1.4 }}
              >
                Non-custodial Stellar keypair provisioned via social login. Transactions sign in-app
                — no Freighter popup.
              </div>
            )}
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
            {isSocialLogin ? 'Sign out' : 'Disconnect Wallet'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Web2 — Social */}
          <div>
            <div style={sectionLabelStyle}>Login with Email / Social · Web2</div>
            <button
              onClick={() => handleConnect('web3auth')}
              disabled={isConnecting}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: socialConfigured
                  ? 'linear-gradient(135deg, #f0f9ff 0%, #ffffff 100%)'
                  : '#f8fafc',
                border: '1.5px solid #0ea5e9',
                borderRadius: '14px',
                cursor: isConnecting ? 'wait' : 'pointer',
                boxShadow: '0 2px 8px rgba(14, 165, 233, 0.1)',
                transition: 'all 0.15s ease',
                textAlign: 'left',
                opacity: socialConfigured ? 1 : 0.85,
              }}
              title={
                socialConfigured
                  ? 'Open Web3Auth — Google, Apple, GitHub, or email'
                  : 'Set VITE_WEB3AUTH_CLIENT_ID to enable social login'
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%)',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Mail size={18} />
                </div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '800', color: '#0f172a' }}>
                    Login with Google
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                    Apple, GitHub & email via Web3Auth — provisions a Stellar key
                  </div>
                </div>
              </div>
              <span style={{ fontSize: '12.5px', fontWeight: '800', color: '#0284c7' }}>
                {isConnecting ? '...' : 'Login →'}
              </span>
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              margin: '4px 0',
            }}
          >
            <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#cbd5e1' }}>OR</span>
            <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
          </div>

          {/* Web3 — Wallets */}
          <div style={sectionLabelStyle}>Connect Wallet · Web3</div>

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
                  Freighter Wallet
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  Official Stellar Extension
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
                  Albedo Wallet
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  Web-based Stellar wallet (no extension)
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
                  Ledger Nano
                </div>
                <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '1px' }}>
                  Hardware wallet via WebUSB/WebBluetooth
                </div>
              </div>
            </div>
            <span style={{ fontSize: '12.5px', fontWeight: '800', color: '#334155' }}>
              {isConnecting ? '...' : 'Connect →'}
            </span>
          </button>

          {errorCode === 'NOT_INSTALLED' && !error?.includes('VITE_WEB3AUTH') && (
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
              Install Freighter Wallet
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
            Non-custodial · Social keys never leave your browser session
          </div>
        </div>
      )}
    </div>
  );
};

export default WalletConnectModal;
