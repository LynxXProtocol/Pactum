import { useState, useEffect } from 'react';

import './App.css';
import LandingPage from './components/LandingPage';
import DocsPage from './components/DocsPage';
import CreateCommitmentWizard from './components/CreateCommitmentWizard';
import ReputationDashboard from './components/ReputationDashboard';
import FreighterInstallModal from './components/FreighterInstallModal';
import WalletConnectButton from './components/WalletConnectButton';
import DecryptTermsModal from './components/DecryptTermsModal';
import { useCommitments } from './hooks/useCommitments';
import { useSyncCache } from './hooks/useSyncCache';
import { fetchEncryptedTerms } from './lib/api';
import type { Commitment, CommitmentStatus } from './lib/api';
import { useWallet } from './context/WalletContext';
import { wsClient } from './lib/wsClient';
import type { WalletProvider } from './lib/wallet';
import {
  submitAttest,
  submitDispute,
  submitResolve,
  submitInitRegistry,
} from './lib/sorobanTxHelpers';
import { ThemeSelector } from './context/ThemeContext';
import { Menu, X, User, Lock } from 'lucide-react';
import { MeshNetworkMonitor } from './components/MeshNetworkMonitor';
import LanguageSwitcher from './components/LanguageSwitcher';
import { useTranslation } from 'react-i18next';

interface CommitmentItemProps {
  commitment: Commitment;
  connectedAddress: string | null;
  provider: WalletProvider | null;
}

function CommitmentItem({ commitment, connectedAddress, provider }: CommitmentItemProps) {
  const { t } = useTranslation();
  const [showDecryptModal, setShowDecryptModal] = useState(false);
  const [ciphertext, setCiphertext] = useState<string | null>(null);
  const [loadingCiphertext, setLoadingCiphertext] = useState(false);

  const handleDecryptClick = async () => {
    if (ciphertext) {
      setShowDecryptModal(true);
      return;
    }
    setLoadingCiphertext(true);
    try {
      const res = await fetchEncryptedTerms(String(commitment.id));
      setCiphertext(res.ciphertext);
      setShowDecryptModal(true);
    } catch (err) {
      console.error('[CommitmentItem] Failed to fetch ciphertext:', err);
    } finally {
      setLoadingCiphertext(false);
    }
  };

  return (
    <>
      <div className="commitment-item" key={commitment.id}>
        <div className="commitment-avatar" style={{ background: '#e8e4f3', color: '#5b4d8a' }}>
          {commitment.issuer.charAt(0)}
        </div>
        <div className="commitment-info">
          <div
            className="commitment-id"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            Commitment #{commitment.id}
            {commitment.encrypted && (
              <span
                title={t('app.commitment.termsEncrypted')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  fontSize: '10px',
                  fontWeight: '700',
                  color: '#4f46e5',
                  background: '#eef2ff',
                  padding: '1px 6px',
                  borderRadius: '100px',
                  border: '1px solid #a5b4fc',
                }}
              >
                <Lock size={9} /> E2E Encrypted
              </span>
            )}
          </div>
          <div className="commitment-parties">
            {commitment.issuer} &rarr; {commitment.counterparty}
          </div>
          <div className="commitment-due">
            {new Date(commitment.due_at * 1000).toLocaleDateString()}
          </div>
        </div>
        <div
          className="commitment-status"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}
        >
          <span className={`badge ${commitment.status.toLowerCase()}`}>
            <span className="badge-dot"></span>
            {commitment.status}
          </span>
          {commitment.encrypted && (
            <button
              type="button"
              id={`decrypt-btn-${commitment.id}`}
              onClick={handleDecryptClick}
              disabled={loadingCiphertext}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                fontWeight: '700',
                color: '#4f46e5',
                background: '#eef2ff',
                border: '1px solid #a5b4fc',
                borderRadius: '6px',
                padding: '3px 8px',
                cursor: loadingCiphertext ? 'wait' : 'pointer',
              }}
            >
              <Lock size={10} />
              {loadingCiphertext ? t('app.commitment.loading') : t('app.commitment.decrypt')}
            </button>
          )}
        </div>
      </div>

      {showDecryptModal && ciphertext && connectedAddress && (
        <DecryptTermsModal
          commitmentId={commitment.id}
          ciphertext={ciphertext}
          issuerAddress={commitment.issuer}
          counterpartyAddress={commitment.counterparty}
          viewerAddress={connectedAddress}
          isFreighter={provider === 'freighter'}
          onClose={() => setShowDecryptModal(false)}
        />
      )}
    </>
  );
}

function renderCommitmentItem(
  commitment: Commitment,
  connectedAddress: string | null,
  provider: WalletProvider | null,
) {
  return (
    <CommitmentItem
      key={commitment.id}
      commitment={commitment}
      connectedAddress={connectedAddress}
      provider={provider}
    />
  );
}

function InlineWalletError() {
  const { error, errorCode, clearError } = useWallet();
  return errorCode === 'NOT_INSTALLED' ? (
    <FreighterInstallModal error={error} onDismiss={clearError} />
  ) : null;
}

export default function App() {
  const { t } = useTranslation();
  const wallet = useWallet();
  // WebRTC peer sync needs a wallet that can sign an arbitrary message to attest its
  // session key (SEP-53 `signMessage`) — today that's Freighter only, same gating the
  // encryption flow already uses.
  useSyncCache(wallet.provider === 'freighter' ? wallet.address : null);

  const [activePage, setActivePage] = useState('landing');
  const [commitmentStatus, setCommitmentStatus] = useState<CommitmentStatus>();
  const [reputationAddress, setReputationAddress] = useState(
    'GAJKUMA6V4MJKQPFM4MXNMWQZX3CTMK2KMMCSZQPK5JXBZWBZM7S4C',
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleGenericSubmit = async (actionName: string, actionFn: () => Promise<any>) => {
    if (!wallet.address || !wallet.provider) {
      alert('Please connect your wallet first.');
      return;
    }
    setIsSubmitting(true);
    try {
      await actionFn();
      alert(`${actionName} successful!`);
    } catch (e: any) {
      console.error(e);
      alert(`Error during ${actionName}: ${e.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const commitmentsQuery = useCommitments(commitmentStatus ? { status: commitmentStatus } : {});

  const handleNavigateReputation = (addr: string) => {
    setReputationAddress(addr);
    setActivePage('reputation');
    setIsMobileMenuOpen(false);
    window.history.pushState({}, '', `/reputation/${addr}`);
  };

  const handleMyProfile = () => {
    if (wallet.address) {
      handleNavigateReputation(wallet.address);
    } else {
      setActivePage('reputation');
      setIsMobileMenuOpen(false);
    }
  };

  useEffect(() => {
    const handleUrlChange = () => {
      const path = window.location.pathname;
      if (path.startsWith('/reputation/')) {
        const addr = path.replace('/reputation/', '').trim();
        if (addr) {
          setReputationAddress(addr);
          setActivePage('reputation');
        }
      }
    };

    handleUrlChange();
    window.addEventListener('popstate', handleUrlChange);

    wsClient.connect();

    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      wsClient.disconnect();
    };
  }, []);

  if (activePage === 'landing') {
    return (
      <LandingPage
        onLaunchApp={() => setActivePage('dashboard')}
        onOpenDocs={() => setActivePage('docs')}
      />
    );
  }

  if (activePage === 'docs') {
    return (
      <DocsPage
        onBack={() => setActivePage('landing')}
        onLaunchApp={() => setActivePage('dashboard')}
      />
    );
  }

  return (
    <>
      {/* Mobile Drawer Backdrop Overlay */}
      {isMobileMenuOpen && (
        <div className="mobile-backdrop" onClick={() => setIsMobileMenuOpen(false)} />
      )}

      <div className="app-shell">
        {/* ── Sidebar / Off-Canvas Mobile Drawer ── */}
        <aside className={`sidebar ${isMobileMenuOpen ? 'mobile-open' : ''}`}>
          <div
            className="sidebar-logo"
            onClick={() => {
              setActivePage('landing');
              setIsMobileMenuOpen(false);
            }}
            style={{ cursor: 'pointer' }}
            title="Go to Home Page"
          >
            <div className="logo-mark">
              <div className="logo-icon">
                <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 2L3 6v8l7 4 7-4V6l-7-4zm0 2.2l5 2.8v5.6L10 15.4 5 12.6V7l5-2.8z" />
                </svg>
              </div>
              <span className="logo-name">{t('app.title')}</span>
            </div>
            <div className="logo-tagline">{t('app.tagline')}</div>
          </div>

          <nav className="sidebar-nav">
            <span className="nav-section-label">{t('app.nav.overview')}</span>

            <button
              className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`}
              id="nav-dashboard"
              onClick={() => {
                setActivePage('dashboard');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1" y="1" width="6" height="6" rx="1.5" />
                  <rect x="9" y="1" width="6" height="6" rx="1.5" />
                  <rect x="1" y="9" width="6" height="6" rx="1.5" />
                  <rect x="9" y="9" width="6" height="6" rx="1.5" />
                </svg>
              </span>
              {t('app.nav.dashboard')}
            </button>

            <button
              className={`nav-item ${activePage === 'commitments' ? 'active' : ''}`}
              id="nav-commitments"
              onClick={() => {
                setActivePage('commitments');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 4h12M2 8h12M2 12h8" />
                </svg>
              </span>
              {t('app.nav.commitments')}
              <span className="nav-badge" id="badge-commitments">
                4
              </span>
            </button>

            <span className="nav-section-label">{t('app.nav.actions')}</span>

            <button
              className={`nav-item ${activePage === 'create' ? 'active' : ''}`}
              id="nav-create"
              aria-label={t('app.nav.create')}
              onClick={() => {
                setActivePage('create');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M8 2v12M2 8h12" />
                </svg>
              </span>
              {t('app.nav.create')}
            </button>

            <button
              className={`nav-item ${activePage === 'attest' ? 'active' : ''}`}
              id="nav-attest"
              onClick={() => {
                setActivePage('attest');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2.5 8.5l3.5 3.5 7.5-7.5" />
                </svg>
              </span>
              {t('app.nav.attest')}
            </button>

            <button
              className={`nav-item ${activePage === 'dispute' ? 'active' : ''}`}
              id="nav-dispute"
              onClick={() => {
                setActivePage('dispute');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 2L1 14h14L8 2z" />
                  <path d="M8 6v4M8 11.5v.5" />
                </svg>
              </span>
              {t('app.nav.raiseDispute')}
            </button>

            <button
              className={`nav-item ${activePage === 'resolve' ? 'active' : ''}`}
              id="nav-resolve"
              onClick={() => {
                setActivePage('resolve');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="8" r="6" />
                  <path d="M5 8l2 2 4-4" />
                </svg>
              </span>
              {t('app.nav.resolveDispute')}
            </button>

            <span className="nav-section-label">{t('app.nav.lookupProfile')}</span>

            <button className="nav-item" id="nav-my-profile" onClick={handleMyProfile}>
              <span className="nav-icon">
                <User size={16} />
              </span>
              {t('app.nav.myProfile')}
            </button>

            <button
              className={`nav-item ${activePage === 'reputation' ? 'active' : ''}`}
              id="nav-reputation"
              onClick={() => {
                setActivePage('reputation');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="5" r="3" />
                  <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" />
                </svg>
              </span>
              {t('app.nav.reputationLookup')}
            </button>

            <button
              className={`nav-item ${activePage === 'lookup' ? 'active' : ''}`}
              id="nav-lookup"
              onClick={() => {
                setActivePage('lookup');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <circle cx="6.5" cy="6.5" r="4.5" />
                  <path d="M14 14l-3-3" />
                </svg>
              </span>
              {t('app.nav.getCommitment')}
            </button>

            <span className="nav-section-label">{t('app.nav.system')}</span>

            <button
              className={`nav-item ${activePage === 'docs' ? 'active' : ''}`}
              id="nav-docs"
              onClick={() => {
                setActivePage('docs');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 2.5h10a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1z" />
                  <path d="M5 5.5h6M5 8.5h6M5 11.5h4" />
                </svg>
              </span>
              {t('app.nav.docs')}
            </button>

            <button
              className={`nav-item ${activePage === 'mesh' ? 'active' : ''}`}
              id="nav-mesh"
              onClick={() => {
                setActivePage('mesh');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="8" r="6" />
                  <path d="M2 8h12M8 2a10 10 0 010 12M8 2a10 10 0 000 12" />
                </svg>
              </span>
              {t('app.nav.bftMesh')}
            </button>

            <button
              className={`nav-item ${activePage === 'initialize' ? 'active' : ''}`}
              id="nav-initialize"
              onClick={() => {
                setActivePage('initialize');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="8" r="2.5" />
                  <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.54 11.54l1.41 1.41M3.05 12.95l1.42-1.42M11.54 4.46l1.41-1.41" />
                </svg>
              </span>
              {t('app.nav.initialize')}
            </button>
          </nav>

          <div className="sidebar-footer">
            <button
              className="nav-item"
              style={{
                width: '100%',
                marginBottom: '8px',
                color: 'var(--text-secondary)',
                fontSize: '13px',
              }}
              onClick={() => {
                setActivePage('landing');
                setIsMobileMenuOpen(false);
              }}
            >
              <span className="nav-icon">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 6.5L8 1l7 5.5V14a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6.5z" />
                </svg>
              </span>
              {t('app.nav.home')}
            </button>
            <div className="sidebar-network">
              <span className="network-dot"></span>
              <span className="network-name">{t('app.nav.network')}</span>
              <span className="network-sub">{t('app.nav.live')}</span>
            </div>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="main-content">
          {/* Topbar */}
          <header
            className="topbar"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Mobile Hamburger Toggle Button */}
              <button
                className="hamburger-btn"
                onClick={() => setIsMobileMenuOpen((prev: boolean) => !prev)}
                aria-label={t('app.topbar.toggleNav')}
              >
                {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>

              <button
                onClick={() => setActivePage('landing')}
                className="btn btn-secondary btn-sm"
                title={t('app.topbar.backToHome')}
              >
                {t('app.topbar.home')}
              </button>

              <span className="topbar-title" id="topbar-title" style={{ margin: 0 }}>
                {activePage === 'reputation'
                  ? t('app.topbar.title.reputation')
                  : activePage === 'commitments'
                    ? t('app.topbar.title.commitments')
                    : activePage === 'create'
                      ? t('app.topbar.title.create')
                      : activePage === 'attest'
                        ? t('app.topbar.title.attest')
                        : activePage === 'dispute'
                          ? t('app.topbar.title.dispute')
                          : activePage === 'resolve'
                            ? t('app.topbar.title.resolve')
                            : activePage === 'lookup'
                              ? t('app.topbar.title.lookup')
                              : activePage === 'mesh'
                                ? t('app.topbar.title.mesh')
                                : activePage === 'initialize'
                                  ? t('app.topbar.title.initialize')
                                  : t('app.topbar.title.dashboard')}
              </span>
            </div>
            <div
              className="topbar-actions"
              style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
            >
              <ThemeSelector />
              <LanguageSwitcher />
              <div className="search-bar">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <circle cx="6.5" cy="6.5" r="4.5" />
                  <path d="M14 14l-3-3" />
                </svg>
                <input type="text" placeholder={t('app.topbar.searchPlaceholder')} id="global-search" />
              </div>

              {/* Topbar Wallet Connect Component */}
              <WalletConnectButton variant="light" />

              <button className="btn btn-primary btn-sm" onClick={() => setActivePage('create')}>
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M8 2v12M2 8h12" />
                </svg>
                <span className="btn-text">{t('app.topbar.new')}</span>
              </button>
            </div>
          </header>

          {/* Inline On-Screen Wallet Error / Installation Alert Banner */}
          <InlineWalletError />

          {/* Toast Container */}
          <div className="toast-container" id="toast-container"></div>

          {/* ──────────────────────────────────────────────
         PAGE: Dashboard
         ────────────────────────────────────────────── */}
          <section
            className={`page ${activePage === 'dashboard' ? 'active' : ''}`}
            id="page-dashboard"
          >
            <div className="section-header">
              <div>
                <div className="section-title">{t('app.nav.overview')}</div>
                <div className="section-sub">{t('reputation.atAGlance')}</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => {}}>
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13.7 6A6 6 0 1 0 12 12" />
                  <path d="M14 2v4h-4" />
                </svg>
                Refresh
              </button>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">{t('reputation.totalCommitments')}</div>
                <div className="stat-value" id="stat-total">
                  4
                </div>
                <div className="stat-change">{t('docs.deployment.stellar')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{t('app.commitment.status.fulfilled')}</div>
                <div className="stat-value green" id="stat-fulfilled">
                  2
                </div>
                <div className="stat-change">{t('docs.states.fulfilled')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{t('app.commitment.status.pending')}</div>
                <div className="stat-value" id="stat-pending" style={{ color: 'var(--gray)' }}>
                  1
                </div>
                <div className="stat-change">{t('docs.states.pending')}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{t('app.commitment.status.breached')}</div>
                <div className="stat-value red" id="stat-breached">
                  1
                </div>
                <div className="stat-change">{t('docs.states.breached')}</div>
              </div>
            </div>

            <div className="two-col">
              {/* Recent Commitments */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('reputation.recentCommitments')}</div>
                  <button className="btn btn-ghost btn-sm" onClick={() => {}}>
                    View All
                  </button>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  <div
                    className="commitment-list h-[340px] overflow-auto"
                    style={{ padding: '16px' }}
                  >
                    <div className="commitment-item">
                      <div
                        className="commitment-avatar"
                        style={{ background: '#e8e4f3', color: '#5b4d8a' }}
                      >
                        G
                      </div>
                      <div className="commitment-info">
                        <div className="commitment-id">Commitment #4</div>
                        <div className="commitment-parties">GCJUKU...A6V4 &rarr; GB4UFB...HHZX</div>
                        <div className="commitment-due">Due in 8d</div>
                      </div>
                      <div className="commitment-status">
                        <span className="badge pending">
                          <span className="badge-dot"></span>Pending
                        </span>
                      </div>
                    </div>

                    <div className="commitment-item">
                      <div
                        className="commitment-avatar"
                        style={{ background: '#dde8f5', color: '#3060a0' }}
                      >
                        G
                      </div>
                      <div className="commitment-info">
                        <div className="commitment-id">Commitment #3</div>
                        <div className="commitment-parties">GB4UFB...HHZX &rarr; GAJKUM...7S4C</div>
                        <div className="commitment-due">Due 2d ago</div>
                      </div>
                      <div className="commitment-status">
                        <span className="badge fulfilled">
                          <span className="badge-dot"></span>Fulfilled
                        </span>
                      </div>
                    </div>

                    <div className="commitment-item">
                      <div
                        className="commitment-avatar"
                        style={{ background: '#fae8dc', color: '#a0522d' }}
                      >
                        G
                      </div>
                      <div className="commitment-info">
                        <div className="commitment-id">Commitment #2</div>
                        <div className="commitment-parties">GAJKUM...7S4C &rarr; GCJUKU...A6V4</div>
                        <div className="commitment-due">Due Jul 26</div>
                      </div>
                      <div className="commitment-status">
                        <span className="badge breached">
                          <span className="badge-dot"></span>Breached
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Side Panel */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* Contract Info */}
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Contract</div>
                    <span className="badge fulfilled">
                      <span className="badge-dot"></span>
                      Deployed
                    </span>
                  </div>
                  <div className="card-body" style={{ paddingTop: '14px' }}>
                    <div className="detail-panel">
                      <div className="detail-row">
                        <span className="detail-key">Network</span>
                        <span className="detail-val">Stellar Testnet</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Contract ID</span>
                        <span
                          className="detail-val mono"
                          style={{ fontSize: '11px', wordBreak: 'break-all' }}
                        >
                          CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-key">Dispute Window</span>
                        <span className="detail-val">7 days</span>
                      </div>
                    </div>
                    <a
                      href="https://stellar.expert/explorer/testnet/contract/CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E"
                      target="_blank"
                      rel="noopener"
                      className="btn btn-secondary btn-sm btn-full"
                      style={{ marginTop: '12px' }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-4" />
                        <path d="M14 2H9m5 0v5M8 8l6-6" />
                      </svg>
                      View on Stellar Expert
                    </a>
                  </div>
                </div>

                {/* Activity Timeline */}
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">Recent Activity</div>
                  </div>
                  <div className="card-body" style={{ paddingTop: '14px' }}>
                    <div className="timeline">
                      <div className="timeline-item">
                        <div className="timeline-dot-wrap">
                          <div
                            className="timeline-dot"
                            style={{
                              background: 'var(--green)',
                              boxShadow: '0 0 0 2px rgba(52,199,89,0.2)',
                            }}
                          ></div>
                          <div className="timeline-line"></div>
                        </div>
                        <div className="timeline-body">
                          <div className="timeline-label">Commitment #3 Attested</div>
                          <div className="timeline-date">Marked as Fulfilled</div>
                        </div>
                      </div>
                      <div className="timeline-item">
                        <div className="timeline-dot-wrap">
                          <div
                            className="timeline-dot"
                            style={{
                              background: 'var(--accent)',
                              boxShadow: '0 0 0 2px rgba(0,113,227,0.2)',
                            }}
                          ></div>
                          <div className="timeline-line"></div>
                        </div>
                        <div className="timeline-body">
                          <div className="timeline-label">Commitment #4 Created</div>
                          <div className="timeline-date">New pending commitment</div>
                        </div>
                      </div>
                      <div className="timeline-item">
                        <div className="timeline-dot-wrap">
                          <div
                            className="timeline-dot"
                            style={{
                              background: 'var(--red)',
                              boxShadow: '0 0 0 2px rgba(255,59,48,0.2)',
                            }}
                          ></div>
                          <div className="timeline-line"></div>
                        </div>
                        <div className="timeline-body">
                          <div className="timeline-label">Commitment #2 Breached</div>
                          <div className="timeline-date">Attested as Breached</div>
                        </div>
                      </div>
                      <div className="timeline-item">
                        <div className="timeline-dot-wrap">
                          <div className="timeline-dot"></div>
                        </div>
                        <div className="timeline-body">
                          <div className="timeline-label">Contract Initialized</div>
                          <div className="timeline-date">Arbitrator set</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Commitments List
         ────────────────────────────────────────────── */}
          <section
            className={`page ${activePage === 'commitments' ? 'active' : ''}`}
            id="page-commitments"
          >
            <div className="section-header">
              <div>
                <div className="section-title">Commitments</div>
                <div className="section-sub">All registered commitments on the registry</div>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <div className="tabs" id="filter-tabs">
                  {[
                    { label: 'All', value: undefined as CommitmentStatus | undefined },
                    { label: 'Pending', value: 'Pending' as CommitmentStatus },
                    { label: 'Fulfilled', value: 'Fulfilled' as CommitmentStatus },
                    { label: 'Breached', value: 'Breached' as CommitmentStatus },
                  ].map((tab) => (
                    <button
                      key={tab.label}
                      className={`tab-btn ${commitmentStatus === tab.value ? 'active' : ''}`}
                      onClick={() => setCommitmentStatus(tab.value)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => {}}>
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M8 2v12M2 8h12" />
                  </svg>
                  Create
                </button>
              </div>
            </div>
            <div className="commitment-list" id="commitments-list-page">
              {commitmentsQuery.isLoading && (
                <div className="inline-alert info">Loading commitments...</div>
              )}
              {commitmentsQuery.isError && (
                <div className="inline-alert warning">
                  Failed to load commitments from the backend.
                </div>
              )}
              {commitmentsQuery.data?.map((c) =>
                renderCommitmentItem(c, wallet.address, wallet.provider),
              )}
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Create Commitment
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'create' ? 'active' : ''}`} id="page-create">
            <div className="section-header">
              <div>
                <div className="section-title">{t('app.nav.create')}</div>
                <div className="section-sub">
                  {t('docs.sampleCommitments.title')}
                </div>
              </div>
            </div>

            <CreateCommitmentWizard
              onSubmit={(payload) => console.log('commitment payload', payload)}
              onSuccess={(result) => {
                console.log('Transaction successful:', result);
                if (wallet.address) {
                  handleNavigateReputation(wallet.address);
                } else {
                  setActivePage('reputation');
                }
              }}
            />
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Attest
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'attest' ? 'active' : ''}`} id="page-attest">
            <div className="section-header">
              <div>
                <div className="section-title">{t('app.actions.attest')}</div>
                <div className="section-sub">
                  {t('docs.states.pending')}
                </div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('app.commitment.status.attested')}</div>
                </div>
                <div className="card-body">
                  <div className="inline-alert warning">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 2L1 14h14L8 2z" />
                      <path d="M8 6v4M8 11.5v.5" />
                    </svg>
                    Only the issuer or counterparty may attest. You have 7 days after attestation to
                    raise a dispute.
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="attest-caller">
                      Your Address (Caller)
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      id="attest-caller"
                      placeholder={t('app.actions.searchPlaceholder')}
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <div className="form-hint">
                      {t('app.actions.canOnlyResolve')}
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="attest-id">
                      {t('app.actions.commitmentId')}
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      id="attest-id"
                      placeholder={t('app.actions.idPlaceholder')}
                      min="1"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="attest-outcome">
                      {t('common.details')}
                    </label>
                    <select className="form-select" id="attest-outcome">
                      <option value="">{t('app.commitment.selectOutcome')}</option>
                      <option value="Fulfilled">{t('app.commitment.fulfilledOnTime')}</option>
                      <option value="Late">{t('app.commitment.lateAfterDue')}</option>
                      <option value="Breached">{t('app.commitment.breachedNotDelivered')}</option>
                    </select>
                    <div className="form-hint">
                      {t('docs.outcomes.finality')}
                    </div>
                  </div>

                  <button
                    className="btn btn-primary btn-full"
                    id="btn-attest"
                    onClick={() => {
                      const idStr = (document.getElementById('attest-id') as HTMLInputElement)
                        ?.value;
                      const outcome = (
                        document.getElementById('attest-outcome') as HTMLSelectElement
                      )?.value;
                      if (!idStr || !outcome) {
                        alert('Please provide Commitment ID and Outcome');
                        return;
                      }
                      handleGenericSubmit('Attest Commitment', () =>
                        submitAttest(Number(idStr), outcome, wallet.address!, wallet.provider!),
                      );
                    }}
                    disabled={isSubmitting}
                  >
                    {isSubmitting && <div className="spinner"></div>}
                    <span className="btn-text">
                      {isSubmitting ? t('app.actions.submitToSoroban') : t('app.actions.attest')}
                    </span>
                  </button>
                </div>
              </div>

              {/* Outcome Guide */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('docs.outcomes.title')}</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="detail-panel">
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge fulfilled" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>{t('app.commitment.status.fulfilled')}
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        {t('docs.outcomes.fulfilledDesc')}
                      </span>
                    </div>
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge late" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>{t('app.commitment.status.late')}
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        {t('docs.outcomes.lateDesc')}
                      </span>
                    </div>
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge breached" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>{t('app.commitment.status.breached')}
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        {t('docs.outcomes.breachedDesc')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Dispute
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'dispute' ? 'active' : ''}`} id="page-dispute">
            <div className="section-header">
              <div>
                <div className="section-title">{t('app.nav.raiseDispute')}</div>
                <div className="section-sub">
                  {t('docs.dispute.raised')}
                </div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('docs.dispute.title')}</div>
                </div>
                <div className="card-body">
                  <div className="inline-alert warning">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 2L1 14h14L8 2z" />
                      <path d="M8 6v4M8 11.5v.5" />
                    </svg>
                    {t('docs.dispute.arbitratorReview')}
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="dispute-caller">
                      {t('app.actions.issuer')}
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      id="dispute-caller"
                      placeholder="G..."
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="dispute-id">
                      Commitment ID
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      id="dispute-id"
                      placeholder="1"
                      min="1"
                    />
                    <div className="form-hint">
                      The ID of the commitment whose attestation you wish to contest.
                    </div>
                  </div>

                  <button
                    className="btn btn-destructive btn-full"
                    id="btn-dispute"
                    disabled={isSubmitting}
                    onClick={() => {
                      const idStr = (document.getElementById('dispute-id') as HTMLInputElement)
                        ?.value;
                      const reason = (
                        document.getElementById('dispute-reason') as HTMLTextAreaElement
                      )?.value;
                      if (!idStr || !reason) {
                        alert('Please provide Commitment ID and Reason');
                        return;
                      }
                      handleGenericSubmit('Raise Dispute', () =>
                        submitDispute(Number(idStr), reason, wallet.address!, wallet.provider!),
                      );
                    }}
                  >
                    {isSubmitting ? (
                      <div className="spinner"></div>
                    ) : (
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8 2L1 14h14L8 2z" />
                        <path d="M8 6v4" />
                      </svg>
                    )}
                    <span className="btn-text">
                      {isSubmitting ? 'Submitting...' : 'Raise Dispute'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div className="card-title">Dispute Process</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="timeline">
                    <div className="timeline-item">
                      <div className="timeline-dot-wrap">
                        <div
                          className="timeline-dot"
                          style={{
                            background: 'var(--orange)',
                            boxShadow: '0 0 0 2px rgba(255,159,10,0.2)',
                          }}
                        ></div>
                        <div className="timeline-line"></div>
                      </div>
                      <div className="timeline-body">
                        <div className="timeline-label">Dispute Raised</div>
                        <div className="timeline-date">Commitment flagged as Disputed on-chain</div>
                      </div>
                    </div>
                    <div className="timeline-item">
                      <div className="timeline-dot-wrap">
                        <div
                          className="timeline-dot"
                          style={{
                            background: 'var(--purple)',
                            boxShadow: '0 0 0 2px rgba(175,82,222,0.2)',
                          }}
                        ></div>
                        <div className="timeline-line"></div>
                      </div>
                      <div className="timeline-body">
                        <div className="timeline-label">Arbitrator Review</div>
                        <div className="timeline-date">Designated arbitrator reviews the case</div>
                      </div>
                    </div>
                    <div className="timeline-item">
                      <div className="timeline-dot-wrap">
                        <div
                          className="timeline-dot"
                          style={{
                            background: 'var(--green)',
                            boxShadow: '0 0 0 2px rgba(52,199,89,0.2)',
                          }}
                        ></div>
                      </div>
                      <div className="timeline-body">
                        <div className="timeline-label">Resolution</div>
                        <div className="timeline-date">Final outcome recorded permanently</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Resolve Dispute
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'resolve' ? 'active' : ''}`} id="page-resolve">
            <div className="section-header">
              <div>
                <div className="section-title">{t('app.nav.resolveDispute')}</div>
                <div className="section-sub">{t('app.actions.arbitratorOnly')}</div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('docs.dispute.arbitratorSettles')}</div>
                </div>
                <div className="card-body">
                  <div className="inline-alert info">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 6v4M8 11.5v.5" />
                    </svg>
                    {t('app.actions.arbitratorOnly')}
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="resolve-arbitrator">
                      {t('common.role')}
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      id="resolve-arbitrator"
                      placeholder="G..."
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="resolve-id">
                      {t('app.actions.commitmentId')}
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      id="resolve-id"
                      placeholder={t('app.actions.idPlaceholder')}
                      min="1"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="resolve-outcome">
                      {t('docs.outcomes.title')}
                    </label>
                    <select className="form-select" id="resolve-outcome">
                      <option value="">{t('app.commitment.selectFinalOutcome')}</option>
                      <option value="Fulfilled">{t('app.commitment.fulfilled')}</option>
                      <option value="Late">{t('app.commitment.late')}</option>
                      <option value="Breached">{t('app.commitment.breached')}</option>
                    </select>
                  </div>

                  <button
                    className="btn btn-primary btn-full"
                    id="btn-resolve"
                    disabled={isSubmitting}
                    onClick={() => {
                      const idStr = (document.getElementById('resolve-id') as HTMLInputElement)
                        ?.value;
                      const outcome = (
                        document.getElementById('resolve-outcome') as HTMLSelectElement
                      )?.value;
                      if (!idStr || !outcome) {
                        alert('Please provide Commitment ID and Outcome');
                        return;
                      }
                      handleGenericSubmit('Resolve Dispute', () =>
                        submitResolve(Number(idStr), outcome, wallet.address!, wallet.provider!),
                      );
                    }}
                  >
                    {isSubmitting && <div className="spinner"></div>}
                    <span className="btn-text">
                      {isSubmitting ? t('app.actions.submitToSoroban') : 'Submit Resolution'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div className="card-title">{t('docs.dispute.title')}</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="detail-panel">
                    <div className="detail-row">
                      <span className="detail-key">{t('common.role')}</span>
                      <span className="detail-val">{t('docs.dispute.arbitratorReview')}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">{t('common.setAt')}</span>
                      <span className="detail-val">{t('app.actions.oneTimeSetup')}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">{t('common.authority')}</span>
                      <span className="detail-val">{t('app.actions.canOnlyResolve')}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">{t('docs.outcomes.finality')}</span>
                      <span className="detail-val">
                        {t('docs.outcomes.finality')}
                      </span>
                    </div>
                  </div>
                  <div style={{ marginTop: '14px' }}>
                    <button className="btn btn-secondary btn-full" onClick={() => {}}>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <circle cx="6.5" cy="6.5" r="4.5" />
                        <path d="M14 14l-3-3" />
                      </svg>
                      Fetch Current Arbitrator
                    </button>
                    <div id="arbitrator-result" style={{ marginTop: '10px' }}></div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Reputation Lookup
         ────────────────────────────────────────────── */}
          <section
            className={`page ${activePage === 'reputation' ? 'active' : ''}`}
            id="page-reputation"
          >
            <ReputationDashboard
              initialAddress={reputationAddress}
              onNavigateAddress={(addr) => handleNavigateReputation(addr)}
              onLaunchCreate={() => setActivePage('create')}
            />
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Get Commitment
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'lookup' ? 'active' : ''}`} id="page-lookup">
            <div className="section-header">
              <div>
                <div className="section-title">Get Commitment</div>
                <div className="section-sub">
                  Fetch the full details of any commitment by its ID
                </div>
              </div>
            </div>

            <div className="two-col">
              <div>
                <div className="card" style={{ marginBottom: '16px' }}>
                  <div className="card-header">
                    <div className="card-title">Commitment ID Lookup</div>
                  </div>
                  <div className="card-body">
                    <div className="form-group">
                      <label className="form-label" htmlFor="lookup-id">
                        Commitment ID
                      </label>
                      <input
                        type="number"
                        className="form-input"
                        id="lookup-id"
                        placeholder="e.g. 1"
                        min="1"
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button className="btn btn-secondary" onClick={() => {}}>
                        Check Overdue
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ flex: '1' }}
                        id="btn-lookup"
                        onClick={() => {
                          const id = (document.getElementById('lookup-id') as HTMLInputElement)
                            ?.value;
                          if (!id) return;
                          alert(`Lookup for ${id} not implemented in frontend yet.`);
                        }}
                      >
                        <div className="spinner"></div>
                        <span className="btn-text">Fetch Commitment</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Result */}
                <div className="card" id="lookup-result-card" style={{ display: 'none' }}>
                  <div className="card-header">
                    <div className="card-title">Commitment Details</div>
                    <span className="badge" id="lookup-status-badge"></span>
                  </div>
                  <div className="card-body" style={{ paddingTop: '14px' }}>
                    <div className="detail-panel" id="lookup-details"></div>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => {}}>
                        Attest This
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => {}}>
                        Dispute This
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sample IDs */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Sample Commitments</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="commitment-list" id="sample-commitments"></div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Initialize
         ────────────────────────────────────────────── */}
          <section
            className={`page ${activePage === 'initialize' ? 'active' : ''}`}
            id="page-initialize"
          >
            <div className="section-header">
              <div>
                <div className="section-title">Initialize Contract</div>
                <div className="section-sub">One-time setup — designate the arbitrator address</div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Initialization</div>
                </div>
                <div className="card-body">
                  <div className="inline-alert warning">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 2L1 14h14L8 2z" />
                      <path d="M8 6v4M8 11.5v.5" />
                    </svg>
                    This can only be called once. Once an arbitrator is set it cannot be changed
                    without redeploying the contract.
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="init-arbitrator">
                      Arbitrator Address
                    </label>
                    <input
                      type="text"
                      className="form-input"
                      id="init-arbitrator"
                      placeholder="G..."
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <div className="form-hint">
                      This address will be the sole entity able to resolve disputed commitments. It
                      must authorize this transaction.
                    </div>
                  </div>

                  <button
                    className="btn btn-primary btn-full"
                    id="btn-init"
                    disabled={isSubmitting}
                    onClick={() => {
                      handleGenericSubmit('Initialize Contract', () =>
                        submitInitRegistry(wallet.address!, wallet.provider!),
                      );
                    }}
                  >
                    {isSubmitting && <div className="spinner"></div>}
                    <span className="btn-text">
                      {isSubmitting ? 'Initializing...' : 'Initialize Contract'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div className="card-title">Contract Status</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="detail-panel">
                    <div className="detail-row">
                      <span className="detail-key">Contract ID</span>
                      <span className="detail-val mono" style={{ fontSize: '11px' }}>
                        CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Network</span>
                      <span className="detail-val">Stellar Testnet</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Status</span>
                      <span className="detail-val">
                        <span className="badge fulfilled">
                          <span className="badge-dot"></span>Already Initialized
                        </span>
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary btn-full"
                    style={{ marginTop: '12px' }}
                    onClick={() => {}}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <circle cx="6.5" cy="6.5" r="4.5" />
                      <path d="M14 14l-3-3" />
                    </svg>
                    Check Current Arbitrator
                  </button>
                  <div id="init-arbitrator-result" style={{ marginTop: '10px' }}></div>
                </div>
              </div>
            </div>
          </section>

          {/* ──────────────────────────────────────────────
               PAGE: BFT Mesh Network
               ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'mesh' ? 'active' : ''}`} id="page-mesh">
            <MeshNetworkMonitor />
          </section>
        </main>
      </div>
    </>
  );
}
