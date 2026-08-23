import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet, CheckCircle2 } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { truncateAddress } from '../lib/wallet';
import WalletConnectModal from './WalletConnectModal';

export interface WalletConnectButtonProps {
  variant?: 'dark' | 'light';
  className?: string;
}

const variantStyles: Record<'dark' | 'light', React.CSSProperties> = {
  dark: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    color: '#ffffff',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '10px',
    padding: '8px 18px',
    fontSize: '12.5px',
    fontWeight: '700',
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(15, 23, 42, 0.15)',
    transition: 'all 0.15s ease',
  },
  light: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: 'rgba(255, 255, 255, 0.8)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 0, 0, 0.08)',
    borderRadius: '9999px', /* Pill shape */
    padding: '8px 18px',
    fontSize: '13px',
    fontWeight: '500',
    color: '#1d1d1f',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
    transition: 'all 0.2s ease',
  },
};

const connectedStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  background: '#f0fdf4',
  borderColor: '#bbf7d0',
  color: '#15803d',
  fontWeight: '700',
  fontFamily: 'monospace',
  borderRadius: '10px',
  padding: '7px 14px',
  fontSize: '12.5px',
  border: '1px solid #bbf7d0',
  cursor: 'pointer',
  boxShadow: '0 2px 6px rgba(34, 197, 94, 0.08)',
};

export const WalletConnectButton: React.FC<WalletConnectButtonProps> = ({
  variant = 'dark',
  className,
}) => {
  const { t } = useTranslation();
  const { address, isConnected, isConnecting } = useWallet();
  const [isOpen, setIsOpen] = useState(false);

  const toggle = () => setIsOpen((prev) => !prev);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <WalletConnectModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
      {isConnected && address ? (
        <button
          onClick={toggle}
          className={className}
          style={connectedStyles}
          title={t('wallet.viewDetails')}
        >
          <CheckCircle2 size={14} color="#22c55e" />
          <span
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            {t('wallet.connected')}
          </span>
          {truncateAddress(address)}
        </button>
      ) : (
        <button
          onClick={toggle}
          disabled={isConnecting}
          className={className}
          style={{ ...variantStyles[variant], cursor: isConnecting ? 'wait' : 'pointer' }}
          title={t('wallet.connectStellar')}
        >
          <Wallet size={variant === 'dark' ? 15 : 14} />
          {isConnecting ? t('wallet.connecting') : t('wallet.connect')}
        </button>
      )}
    </div>
  );
};

export default WalletConnectButton;
