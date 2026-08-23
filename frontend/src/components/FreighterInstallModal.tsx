import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet, ShieldCheck, Download, X, Key, Lock } from 'lucide-react';

export interface FreighterInstallModalProps {
  error: string | null;
  onDismiss: () => void;
}

export const FreighterInstallModal: React.FC<FreighterInstallModalProps> = ({
  error,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  if (!error) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        background: 'rgba(15, 23, 42, 0.4)',
        backdropFilter: 'blur(6px)',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      {/* ── Clean White Card Container ── */}
      <div
        style={{
          position: 'relative',
          maxWidth: '440px',
          width: '100%',
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '20px',
          padding: '32px',
          boxShadow: '0 20px 40px -10px rgba(15, 23, 42, 0.12)',
          textAlign: 'center',
        }}
      >
        {/* Close Button */}
        <button
          onClick={onDismiss}
          style={{
            position: 'absolute',
            top: '20px',
            right: '20px',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '50%',
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
        >
          <X size={16} />
        </button>

        {/* Soft Wallet Icon Badge */}
        <div
          style={{
            width: '60px',
            height: '60px',
            borderRadius: '18px',
            background: '#e0e7ff',
            color: '#4f46e5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 18px auto',
          }}
        >
          <Wallet size={28} />
        </div>

        {/* Title & Description */}
        <h3
          style={{
            fontSize: '20px',
            fontWeight: '800',
            color: '#0f172a',
            margin: '0 0 8px 0',
            letterSpacing: '-0.02em',
          }}
        >
          {t('freighter.title')}
        </h3>
        <p
          style={{ fontSize: '13.5px', color: '#64748b', margin: '0 0 22px 0', lineHeight: '1.5' }}
        >
          {t('freighter.description')}
        </p>

        {/* Simple Features Checklist */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #f1f5f9',
            borderRadius: '14px',
            padding: '16px',
            marginBottom: '24px',
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '12.5px',
              color: '#334155',
              fontWeight: '600',
            }}
          >
            <ShieldCheck size={16} color="#16a34a" style={{ flexShrink: 0 }} />
            <span>{t('wallet.nonCustodial')}</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '12.5px',
              color: '#334155',
              fontWeight: '600',
            }}
          >
            <Key size={16} color="#4f46e5" style={{ flexShrink: 0 }} />
            <span>{t('wallet.signSoroban')}</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '12.5px',
              color: '#334155',
              fontWeight: '600',
            }}
          >
            <Lock size={16} color="#0284c7" style={{ flexShrink: 0 }} />
            <span>{t('wallet.freighterDesc')}</span>
          </div>
        </div>

        {/* Simple Primary Install Button with Hover & Shadow */}
        <a
          href="https://www.freighter.app/"
          target="_blank"
          rel="noopener noreferrer"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            width: '100%',
            background: '#0f172a',
            color: '#ffffff',
            fontWeight: '700',
            fontSize: '13.5px',
            padding: '13px',
            borderRadius: '12px',
            textDecoration: 'none',
            boxShadow: isHovered
              ? '0 8px 20px rgba(15, 23, 42, 0.25)'
              : '0 4px 12px rgba(15, 23, 42, 0.15)',
            transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
            transition: 'all 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <Download size={16} />
          {t('wallet.installFreighter')}
        </a>

        {/* Secondary Dismiss Button */}
        <button
          onClick={onDismiss}
          style={{
            marginTop: '12px',
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            fontWeight: '600',
            fontSize: '12.5px',
            cursor: 'pointer',
            padding: '6px 12px',
          }}
        >
          {t('wallet.dismiss')}
        </button>
      </div>
    </div>
  );
};

export default FreighterInstallModal;
