import { useState, useEffect, lazy, Suspense } from 'react';

import './App.css';
import LandingPage from './components/LandingPage';
import DocsPage from './components/DocsPage';
import RemoteErrorBoundary from './components/RemoteErrorBoundary';
import FreighterInstallModal from './components/FreighterInstallModal';
import WalletConnectButton from './components/WalletConnectButton';
import DecryptTermsModal from './components/DecryptTermsModal';
import RollupStatusPanel from './components/RollupStatusPanel';
import { useCommitments } from './hooks/useCommitments';
import { useSyncCache } from './hooks/useSyncCache';
import { fetchEncryptedTerms, fetchCommitmentById } from './lib/api';
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
import { ThemeToggle } from './components/ThemeToggle';
import { IndexerModeToggle, useIndexerMode } from './context/IndexerModeContext';
import { Menu, X, User, Lock } from 'lucide-react';
import { MeshNetworkMonitor } from './components/MeshNetworkMonitor';
import { SentryErrorBoundary } from './components/SentryErrorBoundary';

interface CommitmentItemProps {
  commitment: Commitment;
  connectedAddress: string | null;
  provider: WalletProvider | null;
}

function CommitmentItem({ commitment, connectedAddress, provider }: CommitmentItemProps) {
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
                title="Terms are end-to-end encrypted"
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
              {loadingCiphertext ? 'Loading…' : 'Decrypt Terms'}
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

function LocalIndexerNotice() {
  const { mode, syncState, lastError, retentionGapDetected } = useIndexerMode();
  if (mode !== 'local') return null;

  if (syncState === 'error') {
    return (
      <div className="inline-alert warning">
        Local Indexer error: {lastError ?? 'unknown error'}. Switch back to Cloud Indexer if this
        persists.
      </div>
    );
  }

  return (
    <div className="inline-alert info">
      Local Indexer is active — commitments are read directly from Soroban RPC via this browser's
      IndexedDB, bypassing the backend.
      {retentionGapDetected &&
        " Some older history may be missing (outside the RPC provider's event retention window) — switch to Cloud Indexer for full history."}
    </div>
  );
}

function InlineWalletError() {
  const { error, errorCode, clearError } = useWallet();
  return errorCode === 'NOT_INSTALLED' ? (
    <FreighterInstallModal error={error} onDismiss={clearError} />
  ) : null;
}

// Loaded at runtime from independently compiled/deployed remotes over Module Federation, not
// bundled into the host — see vite.config.ts `remotes` and docs/module-federation.md.
const CreateCommitmentWizard = lazy(() => import('wizard/CreateCommitmentWizard'));
const ReputationDashboard = lazy(() => import('dashboard/ReputationDashboard'));

function RemoteFallback({ label }: { label: string }) {
  return <div className="inline-alert info">Loading {label}…</div>;
}

export default function App() {
  const wallet = useWallet();
  // WebRTC peer sync needs a wallet that can sign an arbitrary message to attest its
  // session key (SEP-53 `signMessage`) — today that's Freighter only, same gating the
  // encryption flow already uses.
  useSyncCache(wallet.provider === 'freighter' ? wallet.address : null);

  const [activePage, setActivePage] = useState('landing');
  const [commitmentStatus, setCommitmentStatus] = useState<CommitmentStatus>();
  const [reputationAddress, setReputationAddress] = useState(
    'GBY54VG5G4A7DC4D6YJ6GHD4X4QW2AR43JLYZ2QVWSHKACWK3BLDR5IX',
  );
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── PAGE: Get Commitment (id lookup) ──────────────────────────────────────
  const [lookupResult, setLookupResult] = useState<Commitment | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const handleLookup = async () => {
    const raw = (document.getElementById('lookup-id') as HTMLInputElement)?.value;
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id < 0) {
      setLookupError('Enter a valid commitment id.');
      setLookupResult(null);
      return;
    }

    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const commitment = await fetchCommitmentById(id);
      if (!commitment) {
        setLookupError(`No commitment found with id ${id}.`);
      } else {
        setLookupResult(commitment);
      }
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed.');
    } finally {
      setLookupLoading(false);
    }
  };

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
    <SentryErrorBoundary>
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
              <span className="logo-name">Pactum</span>
            </div>
            <div className="logo-tagline">Commitment Registry · Stellar Testnet</div>
          </div>

          <nav className="sidebar-nav">
            <span className="nav-section-label">Overview</span>

            <button
              className={`nav-item ${activePage === 'commitments' ? 'active' : ''}`}
              id="nav-dashboard"
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
                  <rect x="1" y="1" width="6" height="6" rx="1.5" />
                  <rect x="9" y="1" width="6" height="6" rx="1.5" />
                  <rect x="1" y="9" width="6" height="6" rx="1.5" />
                  <rect x="9" y="9" width="6" height="6" rx="1.5" />
                </svg>
              </span>
              Dashboard
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
              Commitments
              <span className="nav-badge" id="badge-commitments">
                4
              </span>
            </button>

            <span className="nav-section-label">Actions</span>

            <button
              className={`nav-item ${activePage === 'create' ? 'active' : ''}`}
              id="nav-create"
              aria-label="Create Commitment navigation"
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
              Create Commitment
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
              Attest
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
              Raise Dispute
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
              Resolve Dispute
            </button>

            <span className="nav-section-label">Lookup & Profile</span>

            <button className="nav-item" id="nav-my-profile" onClick={handleMyProfile}>
              <span className="nav-icon">
                <User size={16} />
              </span>
              My Profile
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
              Reputation Lookup
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
              Get Commitment
            </button>

            <span className="nav-section-label">System</span>

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
              Docs
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
              BFT Mesh Network
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
              Initialize
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
              Home
            </button>
            <IndexerModeToggle />
            <div className="sidebar-network">
              <span className="network-dot"></span>
              <span className="network-name">Stellar Testnet</span>
              <span className="network-sub">Live</span>
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
                aria-label="Toggle Navigation Menu"
              >
                {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>

              <button
                onClick={() => setActivePage('landing')}
                className="btn btn-secondary btn-sm"
                title="Back to Landing Page"
              >
                ← Home
              </button>

              <span className="topbar-title" id="topbar-title" style={{ margin: 0 }}>
                {activePage === 'reputation'
                  ? 'Reputation Lookup'
                  : activePage === 'commitments'
                    ? 'Commitments'
                    : activePage === 'create'
                      ? 'Create Commitment'
                      : activePage === 'attest'
                        ? 'Attest'
                        : activePage === 'dispute'
                          ? 'Raise Dispute'
                          : activePage === 'resolve'
                            ? 'Resolve Dispute'
                            : activePage === 'lookup'
                              ? 'Get Commitment'
                              : activePage === 'mesh'
                                ? 'BFT Mesh Network'
                                : activePage === 'initialize'
                                  ? 'Initialize'
                                  : 'Dashboard'}
              </span>
            </div>
            <div
              className="topbar-actions"
              style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
            >
              <ThemeToggle />
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
                <input type="text" placeholder="Search commitments..." id="global-search" />
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
                <span className="btn-text">New</span>
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
                <div className="section-title">Overview</div>
                <div className="section-sub">Your commitment registry at a glance</div>
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
                <div className="stat-label">Total Commitments</div>
                <div className="stat-value" id="stat-total">
                  4
                </div>
                <div className="stat-change">On Stellar Testnet</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Fulfilled</div>
                <div className="stat-value green" id="stat-fulfilled">
                  2
                </div>
                <div className="stat-change">Kept on time</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Pending</div>
                <div className="stat-value" id="stat-pending" style={{ color: 'var(--gray)' }}>
                  1
                </div>
                <div className="stat-change">Awaiting attestation</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Breached</div>
                <div className="stat-value red" id="stat-breached">
                  1
                </div>
                <div className="stat-change">Not fulfilled</div>
              </div>
            </div>

            <div className="two-col">
              {/* Recent Commitments */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Recent Commitments</div>
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
              <LocalIndexerNotice />
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
                <div className="section-title">Create Commitment</div>
                <div className="section-sub">
                  Register a new on-chain promise between two parties
                </div>
              </div>
            </div>

            <RemoteErrorBoundary remoteName="wizard">
              <Suspense fallback={<RemoteFallback label="Create Commitment wizard" />}>
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
              </Suspense>
            </RemoteErrorBoundary>
          </section>

          {/* ──────────────────────────────────────────────
         PAGE: Attest
         ────────────────────────────────────────────── */}
          <section className={`page ${activePage === 'attest' ? 'active' : ''}`} id="page-attest">
            <div className="section-header">
              <div>
                <div className="section-title">Attest Commitment</div>
                <div className="section-sub">
                  Record the outcome of a commitment after its due date
                </div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Attestation</div>
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
                      placeholder="G..."
                      autoComplete="off"
                      spellCheck="false"
                    />
                    <div className="form-hint">
                      Must be the issuer or counterparty of this commitment.
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="attest-id">
                      Commitment ID
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      id="attest-id"
                      placeholder="1"
                      min="1"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="attest-outcome">
                      Outcome
                    </label>
                    <select className="form-select" id="attest-outcome">
                      <option value="">Select outcome...</option>
                      <option value="Fulfilled">Fulfilled — Delivered on time</option>
                      <option value="Late">Late — Delivered after due date</option>
                      <option value="Breached">Breached — Not delivered</option>
                    </select>
                    <div className="form-hint">
                      This is permanent and cannot be changed unless disputed.
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
                      {isSubmitting ? 'Submitting...' : 'Submit Attestation'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Outcome Guide */}
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Outcome Guide</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="detail-panel">
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge fulfilled" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>Fulfilled
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        The commitment was completed successfully and on time. Boosts the issuer's
                        reputation score.
                      </span>
                    </div>
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge late" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>Late
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        The commitment was eventually completed, but after the agreed due date.
                      </span>
                    </div>
                    <div className="detail-row" style={{ flexDirection: 'column', gap: '6px' }}>
                      <span className="badge breached" style={{ alignSelf: 'flex-start' }}>
                        <span className="badge-dot"></span>Breached
                      </span>
                      <span
                        className="detail-val"
                        style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
                      >
                        The commitment was not fulfilled. Negatively impacts the issuer's reputation
                        score.
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
                <div className="section-title">Raise Dispute</div>
                <div className="section-sub">
                  Contest an attested outcome within the 7-day dispute window
                </div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Dispute Details</div>
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
                    Disputes must be raised within 7 days of the attestation. Once flagged as
                    Disputed, an arbitrator must resolve it.
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="dispute-caller">
                      Your Address (Caller)
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
                <div className="section-title">Resolve Dispute</div>
                <div className="section-sub">Arbitrator-only — settle a contested commitment</div>
              </div>
            </div>

            <div className="two-col">
              <div className="card">
                <div className="card-header">
                  <div className="card-title">Arbitrator Decision</div>
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
                    Only the designated arbitrator address (set at contract initialization) can call
                    this function.
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="resolve-arbitrator">
                      Arbitrator Address
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
                      Commitment ID
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      id="resolve-id"
                      placeholder="1"
                      min="1"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="resolve-outcome">
                      Final Outcome
                    </label>
                    <select className="form-select" id="resolve-outcome">
                      <option value="">Select final outcome...</option>
                      <option value="Fulfilled">Fulfilled</option>
                      <option value="Late">Late</option>
                      <option value="Breached">Breached</option>
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
                      {isSubmitting ? 'Submitting...' : 'Submit Resolution'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div className="card-title">Arbitrator Info</div>
                </div>
                <div className="card-body" style={{ paddingTop: '14px' }}>
                  <div className="detail-panel">
                    <div className="detail-row">
                      <span className="detail-key">Role</span>
                      <span className="detail-val">Designated Arbitrator</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Set At</span>
                      <span className="detail-val">Contract initialization</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Authority</span>
                      <span className="detail-val">Can only resolve Disputed commitments</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-key">Finality</span>
                      <span className="detail-val">
                        Resolution is permanent and cannot be overridden
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
            <RemoteErrorBoundary remoteName="dashboard">
              <Suspense fallback={<RemoteFallback label="Reputation Dashboard" />}>
                <ReputationDashboard
                  initialAddress={reputationAddress}
                  onNavigateAddress={(addr) => handleNavigateReputation(addr)}
                  onLaunchCreate={() => setActivePage('create')}
                />
              </Suspense>
            </RemoteErrorBoundary>
            <RollupStatusPanel demoMode />
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
                    {lookupError && (
                      <div
                        style={{ color: '#dc2626', fontSize: '13px', marginBottom: '10px' }}
                        role="alert"
                      >
                        {lookupError}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        className="btn btn-secondary"
                        disabled={!lookupResult}
                        title={
                          lookupResult
                            ? undefined
                            : 'Fetch a commitment first to check whether it is overdue'
                        }
                        onClick={() => {
                          if (!lookupResult) return;
                          const overdue =
                            lookupResult.status === 'Pending' &&
                            lookupResult.due_at * 1000 < Date.now();
                          alert(
                            overdue
                              ? `Commitment #${lookupResult.id} is overdue (due ${new Date(lookupResult.due_at * 1000).toLocaleString()}).`
                              : `Commitment #${lookupResult.id} is not overdue.`,
                          );
                        }}
                      >
                        Check Overdue
                      </button>
                      <button
                        className="btn btn-primary"
                        style={{ flex: '1' }}
                        id="btn-lookup"
                        disabled={lookupLoading}
                        onClick={handleLookup}
                      >
                        {lookupLoading && <div className="spinner"></div>}
                        <span className="btn-text">
                          {lookupLoading ? 'Fetching...' : 'Fetch Commitment'}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Result */}
                {lookupResult && (
                  <div className="card" id="lookup-result-card">
                    <div className="card-header">
                      <div className="card-title">Commitment Details</div>
                      <span className="badge" id="lookup-status-badge">
                        {lookupResult.status}
                      </span>
                    </div>
                    <div className="card-body" style={{ paddingTop: '14px' }}>
                      <div className="detail-panel" id="lookup-details">
                        <div>
                          <strong>ID:</strong> #{lookupResult.id}
                        </div>
                        <div>
                          <strong>Issuer:</strong> {lookupResult.issuer}
                        </div>
                        <div>
                          <strong>Counterparty:</strong> {lookupResult.counterparty}
                        </div>
                        <div>
                          <strong>Due:</strong>{' '}
                          {new Date(lookupResult.due_at * 1000).toLocaleString()}
                        </div>
                        {lookupResult.outcome && (
                          <div>
                            <strong>Outcome:</strong> {lookupResult.outcome}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
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
    </SentryErrorBoundary>
  );
}
