import { useTranslation, Trans } from 'react-i18next';
import './LandingPage.css';
import { useWallet } from '../context/WalletContext';
import FreighterInstallModal from './FreighterInstallModal';
import WalletConnectButton from './WalletConnectButton';

interface LandingPageProps {
  onLaunchApp: () => void;
  onOpenDocs: () => void;
}

export default function LandingPage({ onLaunchApp, onOpenDocs }: LandingPageProps) {
  const { t } = useTranslation();
  const { error, errorCode, clearError } = useWallet();

  return (
    <div className="landing">
      {/* ── Modern Pop-Up Modals ── */}
      {errorCode === 'NOT_INSTALLED' && (
        <FreighterInstallModal error={error} onDismiss={clearError} />
      )}

      {/* ── Content Wrapper (Above the gradient blob) ── */}
      <div className="lp-content-wrapper">
        {/* ── Nav ── */}
        <nav className="lp-nav">
          <div className="lp-nav-logo">
            <div className="lp-logo-icon">
              <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 2L3 6v8l7 4 7-4V6l-7-4zm0 2.2l5 2.8v5.6L10 15.4 5 12.6V7l5-2.8z" />
              </svg>
            </div>
            <span className="lp-logo-name">{t('common.pactum')}</span>
          </div>

          <div className="lp-nav-links">
            <button className="lp-nav-link" onClick={onOpenDocs}>
              {t('landing.nav.docs')}
            </button>
            <a
              className="lp-nav-link"
              href="https://github.com/amankoli09/Pactum"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('landing.nav.github')}
            </a>
            <a
              className="lp-nav-link"
              href="https://stellar.expert/explorer/testnet/contract/CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('landing.nav.explorer')}
            </a>
          </div>

          <div className="lp-nav-actions">
            <WalletConnectButton variant="light" />
            <button className="lp-btn-primary lp-btn-sm" onClick={onLaunchApp}>
              {t('landing.nav.launchApp')}
            </button>
          </div>
        </nav>

        {/* ── Hero ── */}
        <section className="lp-hero">
          <div className="lp-hero-badge">
            <span className="lp-badge-dot"></span>
            {t('landing.hero.badge')}
          </div>
          <h1 className="lp-hero-title">
            <Trans i18nKey="landing.hero.title" components={{ br: <br /> }} />
          </h1>
          <p className="lp-hero-sub">
            {t('landing.hero.subtitle')}
          </p>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
            <button id="hero-launch-btn" className="lp-btn-primary lp-btn-lg" onClick={onLaunchApp}>
              {t('landing.hero.getStarted')}
            </button>
            <button className="lp-btn-secondary lp-btn-lg" onClick={onOpenDocs}>
              {t('landing.hero.readDocs')}
            </button>
          </div>
        </section>

        {/* ── Bento Grid ── */}
        <section className="lp-bento-container">
          <div className="lp-bento-grid">
            
            {/* Card 1: Immutable Registry */}
            <div className="lp-card lp-card-span-8">
              <div className="lp-card-icon" style={{ color: '#0ea5e9', background: '#e0f2fe' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
              </div>
              <h3 className="lp-card-title">{t('landing.features.immutableRegistry')}</h3>
              <p className="lp-card-desc">
                {t('landing.features.immutableRegistryDesc')}
              </p>
            </div>

            {/* Card 2: Stat */}
            <div className="lp-card lp-card-span-4" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div className="lp-stat-huge">4</div>
              <div className="lp-card-title" style={{ marginTop: 0, fontSize: '18px' }}>{t('reputation.activeCommitments')}</div>
              <p className="lp-card-desc" style={{ fontSize: '14px' }}>{t('landing.stats.recordedSecurely')}</p>
            </div>

            {/* Card 3: Stat */}
            <div className="lp-card lp-card-span-4" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div className="lp-stat-huge">7d</div>
              <div className="lp-card-title" style={{ marginTop: 0, fontSize: '18px' }}>{t('landing.stats.disputeWindow')}</div>
              <p className="lp-card-desc" style={{ fontSize: '14px' }}>{t('landing.stats.contestTime')}</p>
            </div>

            {/* Card 4: Verifiable Reputation */}
            <div className="lp-card lp-card-span-8">
              <div className="lp-card-icon" style={{ color: '#f59e0b', background: '#fef3c7' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                </svg>
              </div>
              <h3 className="lp-card-title">{t('landing.features.verifiableReputation')}</h3>
              <p className="lp-card-desc">
                {t('landing.features.verifiableReputationDesc')}
              </p>
            </div>

            {/* Card 5: Lifecycle Steps */}
            <div className="lp-card lp-card-span-12">
              <div className="lp-card-icon" style={{ color: '#10b981', background: '#d1fae5', marginBottom: '24px' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                </svg>
              </div>
              <h3 className="lp-card-title" style={{ marginTop: 0 }}>{t('docs.lifecycleOverview')}</h3>
              <div style={{ display: 'flex', gap: '24px', marginTop: '16px', flexWrap: 'wrap' }}>
                
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '8px' }}>01 / {t('landing.lifecycle.create')}</div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>{t('landing.lifecycle.createDesc')}</div>
                </div>
                
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '8px' }}>02 / {t('landing.lifecycle.attest')}</div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>{t('landing.lifecycle.attestDesc')}</div>
                </div>

                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '8px' }}>03 / {t('landing.lifecycle.dispute')}</div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>{t('landing.lifecycle.disputeDesc')}</div>
                </div>

                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '8px' }}>04 / {t('landing.lifecycle.resolve')}</div>
                  <div style={{ fontSize: '14px', color: '#475569' }}>{t('landing.lifecycle.resolveDesc')}</div>
                </div>

              </div>
            </div>

          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="lp-footer">
          <div>{t('landing.footer.copyright')}</div>
          <div style={{ marginTop: '12px' }}>
            <a href="https://github.com/amankoli09/Pactum" style={{ color: '#64748b', textDecoration: 'none' }}>{t('landing.nav.github')}</a>
            <span style={{ margin: '0 8px' }}>•</span>
            <a href="https://stellar.expert/explorer/testnet/contract/CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E" style={{ color: '#64748b', textDecoration: 'none' }}>{t('common.contract')}</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
