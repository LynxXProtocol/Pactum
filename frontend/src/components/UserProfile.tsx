import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveIdentity, truncateAddress, type StellarIdentity } from '../lib/identity';
import { Copy, Check } from 'lucide-react';

export interface UserProfileProps {
  address: string;
  showAvatar?: boolean;
  showDomain?: boolean;
  style?: React.CSSProperties;
  className?: string;
  avatarSize?: number;
}

export const UserProfile: React.FC<UserProfileProps> = ({
  address,
  showAvatar = true,
  showDomain = true,
  style,
  className,
  avatarSize = 28,
}) => {
  const { t } = useTranslation();
  const [identity, setIdentity] = useState<StellarIdentity | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    resolveIdentity(address)
      .then((resolved) => {
        if (isMounted) {
          setIdentity(resolved);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIdentity({ address, resolvedAt: Date.now() });
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [address]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const displayName = identity?.username ? identity.username : truncateAddress(address);
  const hasCustomIdentity = Boolean(identity?.username);

  return (
    <div
      className={className}
      title={t('wallet.fullAddress', { address })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        fontFamily: hasCustomIdentity ? 'inherit' : 'monospace',
        ...style,
      }}
    >
      {/* Avatar Icon */}
      {showAvatar && (
        <div
          style={{
            width: `${avatarSize}px`,
            height: `${avatarSize}px`,
            borderRadius: '50%',
            overflow: 'hidden',
            flexShrink: 0,
            background: hasCustomIdentity ? '#e0e7ff' : '#f1f5f9',
            border: hasCustomIdentity ? '1.5px solid #c7d2fe' : '1px solid #cbd5e1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: `${Math.max(10, avatarSize * 0.45)}px`,
            fontWeight: '800',
            color: hasCustomIdentity ? '#3730a3' : '#475569',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          }}
        >
          {isLoading ? (
            <span style={{ fontSize: '10px', color: '#94a3b8' }}>...</span>
          ) : identity?.avatarUrl ? (
            <img
              src={identity.avatarUrl}
              alt={displayName}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          ) : (
            address.charAt(0) || 'G'
          )}
        </div>
      )}

      {/* Identity Label & Domain Tag */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <span
          style={{
            fontWeight: hasCustomIdentity ? '700' : '600',
            color: hasCustomIdentity ? '#0f172a' : '#334155',
            fontSize: '13px',
          }}
        >
          {isLoading ? truncateAddress(address) : displayName}
        </span>

        {showDomain && identity?.domain && (
          <span
            style={{
              fontSize: '10px',
              fontWeight: '700',
              padding: '1px 6px',
              borderRadius: '100px',
              background: '#f1f5f9',
              color: '#64748b',
              border: '1px solid #e2e8f0',
              textTransform: 'lowercase',
            }}
          >
            {identity.domain}
          </span>
        )}

        {/* Lucide Copy Icon */}
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? '#16a34a' : '#94a3b8',
            cursor: 'pointer',
            padding: '2px 4px',
            borderRadius: '4px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.15s ease',
          }}
          title={copied ? t('wallet.copied') : t('wallet.copyAddress')}
        >
          {copied ? <Check size={13} color="#16a34a" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
};

export default UserProfile;
