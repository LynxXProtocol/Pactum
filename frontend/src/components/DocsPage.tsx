import { useTranslation } from 'react-i18next';
import './DocsPage.css';

interface DocsPageProps {
  onBack: () => void;
  onLaunchApp: () => void;
}

const CONTRACT_ID = 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E';

export default function DocsPage({ onBack, onLaunchApp }: DocsPageProps) {
  const { t } = useTranslation();
  return (
    <div className="docs-shell">
      {/* ── Sidebar ── */}
      <aside className="docs-sidebar">
        <div className="docs-sidebar-header">
          <button className="docs-back-btn" onClick={onBack}>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 12L6 8l4-4" />
            </svg>
          </button>
          <div className="docs-sidebar-logo">
            <div className="docs-logo-icon">
              <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 2L3 6v8l7 4 7-4V6l-7-4zm0 2.2l5 2.8v5.6L10 15.4 5 12.6V7l5-2.8z" />
              </svg>
            </div>
            <span>{t('docs.title')}</span>
          </div>
        </div>
        <nav className="docs-nav">
          <div className="docs-nav-group">
            <div className="docs-nav-label">{t('common.overview')}</div>
            <a href="#intro" className="docs-nav-link">
              {t('docs.introduction')}
            </a>
            <a href="#architecture" className="docs-nav-link">
              {t('docs.architecture')}
            </a>
            <a href="#lifecycle" className="docs-nav-link">
              {t('docs.lifecycleOverview')}
            </a>
          </div>
          <div className="docs-nav-group">
            <div className="docs-nav-label">{t('common.contract')}</div>
            <a href="#contract-interface" className="docs-nav-link">
              {t('docs.contract.interface')}
            </a>
            <a href="#contract-deployment" className="docs-nav-link">
              {t('docs.deployment.title')}
            </a>
            <a href="#dispute" className="docs-nav-link">
              {t('docs.dispute.title')}
            </a>
            <a href="#reputation" className="docs-nav-link">
              {t('docs.reputation.title')}
            </a>
          </div>
          <div className="docs-nav-group">
            <div className="docs-nav-label">{t('common.integration')}</div>
            <a href="#api" className="docs-nav-link">
              {t('docs.api.title')}
            </a>
            <a href="#sdk" className="docs-nav-link">
              {t('docs.sdk.title')}
            </a>
            <a href="#localdev" className="docs-nav-link">
              {t('docs.deployment.localDev')}
            </a>
          </div>
          <div className="docs-nav-group">
            <div className="docs-nav-label">{t('common.contribute')}</div>
            <a href="#roadmap" className="docs-nav-link">
              {t('docs.roadmap.title')}
            </a>
            <a href="#contributing" className="docs-nav-link">
              {t('docs.deployment.howToContribute')}
            </a>
          </div>
        </nav>
        <div className="docs-sidebar-footer">
          <button className="docs-launch-btn" onClick={onLaunchApp}>
            {t('landing.nav.launchApp')} →
          </button>
        </div>
      </aside>

      {/* ── Content ── */}
      <main className="docs-content">
        <div className="docs-page">
          {/* ── Introduction ── */}
          <section id="intro" className="docs-section">
            <div className="docs-eyebrow">{t('common.overview')}</div>
            <h1 className="docs-h1">{t('docs.introduction')}</h1>
            <p className="docs-lead">
              Pactum is an on-chain commitment registry built on Soroban, Stellar's smart contract
              platform. It records real-world promises between two parties and builds a public,
              verifiable reputation from whether they kept them.
            </p>
            <div className="docs-callout docs-callout-info">
              <div className="docs-callout-icon">ℹ</div>
              <div>
                <strong>Not an escrow.</strong> Pactum holds no funds. It is purely a registry — a
                tamper-proof record of who promised what to whom, and what happened.
              </div>
            </div>
            <h2 className="docs-h2">{t('docs.whatProblem')}</h2>
            <p>Many real-world commitments aren't one-time payments. They're recurring promises:</p>
            <ul className="docs-list">
              <li>A landlord promising to return a deposit within 30 days</li>
              <li>An API provider guaranteeing 99.9% uptime this quarter</li>
              <li>A freelancer committing to weekly milestone updates</li>
              <li>A DAO grantee promising monthly progress reports</li>
            </ul>
            <p>
              Currently there's no simple, trustless way to record these promises on-chain, or to
              see whether someone has a track record of keeping them. Pactum fills that gap.
            </p>
          </section>

          <div className="docs-divider" />

          {/* ── Architecture ── */}
          <section id="architecture" className="docs-section">
            <div className="docs-eyebrow">{t('common.overview')}</div>
            <h2 className="docs-h1">{t('docs.architecture')}</h2>
            <p>{t('docs.architectureDesc')}</p>

            <div className="docs-arch-diagram">
              <div className="docs-arch-layer">
                <div className="docs-arch-name">{t('docs.arch.registry')}</div>
                <div className="docs-arch-tech">{t('docs.deployment.soroban')}</div>
                <div className="docs-arch-desc">
                  {t('docs.arch.registryDesc')}
                </div>
              </div>
              <div className="docs-arch-arrow">↓</div>
              <div className="docs-arch-layer">
                <div className="docs-arch-name">{t('docs.arch.indexer')}</div>
                <div className="docs-arch-tech">{t('docs.deployment.node')}</div>
                <div className="docs-arch-desc">
                  {t('docs.arch.indexerDesc')}
                </div>
              </div>
              <div className="docs-arch-arrow">↓</div>
              <div className="docs-arch-layer">
                <div className="docs-arch-name">{t('docs.arch.restApi')}</div>
                <div className="docs-arch-tech">{t('docs.deployment.backend')}</div>
                <div className="docs-arch-desc">
                  {t('docs.arch.restApiDesc')}
                </div>
              </div>
              <div className="docs-arch-arrow">↓</div>
              <div className="docs-arch-layer">
                <div className="docs-arch-name">{t('docs.arch.dashboard')}</div>
                <div className="docs-arch-tech">{t('docs.sdk.title')}</div>
                <div className="docs-arch-desc">
                  {t('docs.arch.dashboardDesc')}
                </div>
              </div>
            </div>

            <h2 className="docs-h2">Project structure</h2>
            <pre className="docs-code">{`pactum/
├── contracts/registry/   # Soroban smart contract (Rust)
├── backend/              # REST API + on-chain event indexer (TypeScript)
├── sdk/js/               # Lightweight JS/TS SDK
├── frontend/             # React dashboard
├── docs/                 # Architecture & API reference
└── examples/             # Minimal integration demo`}</pre>
          </section>

          <div className="docs-divider" />

          {/* ── Lifecycle ── */}
          <section id="lifecycle" className="docs-section">
            <div className="docs-eyebrow">{t('common.overview')}</div>
            <h2 className="docs-h1">{t('docs.lifecycleOverview')}</h2>
            <p>{t('docs.lifecycleDesc')}</p>

            <div className="docs-lifecycle">
              <div className="docs-lifecycle-step">
                <div className="docs-lifecycle-badge docs-badge-neutral">Pending</div>
                <div className="docs-lifecycle-label">{t('docs.states.pending')}</div>
              </div>
              <div className="docs-lifecycle-arrow">→</div>
              <div className="docs-lifecycle-step">
                <div className="docs-lifecycle-badge docs-badge-blue">Attested</div>
                <div className="docs-lifecycle-label">{t('docs.states.attestedDesc')}</div>
              </div>
              <div className="docs-lifecycle-arrow">→</div>
              <div className="docs-lifecycle-step">
                <div className="docs-lifecycle-badge docs-badge-orange">Disputed</div>
                <div className="docs-lifecycle-label">{t('docs.states.disputedDesc')}</div>
              </div>
              <div className="docs-lifecycle-arrow">→</div>
              <div className="docs-lifecycle-step">
                <div className="docs-lifecycle-badge docs-badge-green">Resolved</div>
                <div className="docs-lifecycle-label">{t('docs.states.resolvedDesc')}</div>
              </div>
            </div>

            <p>{t('docs.outcomes.possible')}</p>
            <div className="docs-outcomes">
              <div className="docs-outcome">
                <span className="docs-badge docs-badge-green">{t('app.commitment.status.fulfilled')}</span>
                <span>{t('docs.outcomes.fulfilledDesc')}</span>
              </div>
              <div className="docs-outcome">
                <span className="docs-badge docs-badge-orange">{t('app.commitment.status.late')}</span>
                <span>{t('docs.outcomes.lateDesc')}</span>
              </div>
              <div className="docs-outcome">
                <span className="docs-badge docs-badge-red">{t('app.commitment.status.breached')}</span>
                <span>{t('docs.outcomes.breachedDesc')}</span>
              </div>
            </div>
          </section>

          <div className="docs-divider" />

          {/* ── Contract Interface ── */}
          <section id="contract-interface" className="docs-section">
            <div className="docs-eyebrow">{t('common.contract')}</div>
            <h2 className="docs-h1">{t('docs.contract.title')}</h2>
            <p>{t('docs.contract.description')}</p>

            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t('common.method')}</th>
                    <th>{t('common.kind')}</th>
                    <th>{t('common.description')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>create_commitment(issuer, counterparty, terms_hash, due_at)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-blue">write</span>
                    </td>
                    <td>{t('docs.contract.registerDesc')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>attest(commitment_id, outcome)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-blue">write</span>
                    </td>
                    <td>{t('docs.contract.attestDesc')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>dispute(commitment_id, reason)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-blue">write</span>
                    </td>
                    <td>{t('docs.contract.disputeDesc')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>resolve_dispute(commitment_id, outcome)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-blue">write</span>
                    </td>
                    <td>{t('docs.contract.resolveDesc')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>get_commitment(commitment_id)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-neutral">read</span>
                    </td>
                    <td>{t('docs.contract.getCommitmentDesc')}</td>
                  </tr>
                  <tr>
                    <td>
                      <code>get_reputation(address)</code>
                    </td>
                    <td>
                      <span className="docs-badge docs-badge-neutral">read</span>
                    </td>
                    <td>{t('docs.contract.getReputationDesc')}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 className="docs-h2">Outcome enum</h2>
            <pre className="docs-code">{`// Rust / Soroban
pub enum Outcome {
    Fulfilled,
    Late,
    Breached,
}`}</pre>
          </section>

          <div className="docs-divider" />

          {/* ── Deployment ── */}
          <section id="contract-deployment" className="docs-section">
            <div className="docs-eyebrow">{t('common.contract')}</div>
            <h2 className="docs-h1">{t('docs.deployment.title')}</h2>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t('common.network')}</th>
                    <th>{t('common.contractId')}</th>
                    <th>{t('landing.nav.explorer')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t('app.nav.network')}</td>
                    <td>
                      <code className="docs-code-inline">{CONTRACT_ID}</code>
                    </td>
                    <td>
                      <a
                        href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="docs-link"
                      >
                        {t('docs.stellarExpert')} ↗
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 className="docs-h2">Example transactions</h2>
            <div className="docs-tx-list">
              {[
                {
                  label: 'Initialize Contract',
                  hash: '2b9cc1afa24a3bc9a8412e045cc8c23b8d2fc3e83899ae7e3b7b8ba2b1a40552',
                },
                {
                  label: 'Create Commitment',
                  hash: '5cfdc977deb9c5e16be8127611dcbcd7df6a4d67706dec082eee464af1ae34fc',
                },
                {
                  label: 'Attest Commitment',
                  hash: '6e73137635796cd1786c8a6feec8365c92751f514669a3b9a907e27420088890',
                },
              ].map((tx) => (
                <div className="docs-tx-item" key={tx.hash}>
                  <span className="docs-tx-label">{tx.label}</span>
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${tx.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="docs-tx-hash"
                  >
                    {tx.hash.slice(0, 16)}...{tx.hash.slice(-8)} ↗
                  </a>
                </div>
              ))}
            </div>
          </section>

          <div className="docs-divider" />

          {/* ── Dispute ── */}
          <section id="dispute" className="docs-section">
            <div className="docs-eyebrow">{t('common.contract')}</div>
            <h2 className="docs-h1">{t('docs.dispute.title')}</h2>
            <p>{t('docs.dispute.description')}</p>
            <div className="docs-callout docs-callout-warning">
              <div className="docs-callout-icon">⚠</div>
              <div>
                {t('docs.disputeWarning')}
              </div>
            </div>
            <p>
              {t('docs.arbitratorSettles')}
            </p>
            <h2 className="docs-h2">Edge case: overturned disputes</h2>
            <p>
              If a dispute is raised and the arbitrator overturns the original attestation, the
              reputation score reflects only the arbitrator's final decision. The intermediate
              attested outcome has no effect.
            </p>
          </section>

          <div className="docs-divider" />

          {/* ── Reputation ── */}
          <section id="reputation" className="docs-section">
            <div className="docs-eyebrow">{t('common.contract')}</div>
            <h2 className="docs-h1">{t('docs.reputation.title')}</h2>
            <p>{t('docs.reputation.description')}</p>
            <pre className="docs-code">{`{
  "address": "GCJUKU...",
  "fulfilled": 14,
  "late": 2,
  "breached": 1,
  "total": 17
}`}</pre>
            <p>
              Any platform can query this via <code>get_reputation(address)</code> on-chain or via
              the REST API before entering an agreement with an address.
            </p>
          </section>

          <div className="docs-divider" />

          {/* ── REST API ── */}
          <section id="api" className="docs-section">
            <div className="docs-eyebrow">{t('common.integration')}</div>
            <h2 className="docs-h1">{t('docs.api.title')}</h2>
            <p>{t('docs.backend.description')}</p>

            <div className="docs-endpoint">
              <div className="docs-endpoint-header">
                <span className="docs-method docs-method-get">GET</span>
                <code>/reputation/:address</code>
              </div>
              <p>Returns the aggregated reputation for a Stellar address.</p>
              <pre className="docs-code">{`# Example
GET /reputation/GCJUKU...A6V4

# Response
{
  "address": "GCJUKU...A6V4",
  "fulfilled": 14,
  "late": 2,
  "breached": 1,
  "total": 17
}`}</pre>
            </div>

            <div className="docs-endpoint">
              <div className="docs-endpoint-header">
                <span className="docs-method docs-method-get">GET</span>
                <code>/commitments/:id</code>
              </div>
              <p>Returns full details of a specific commitment.</p>
              <pre className="docs-code">{`# Example
GET /commitments/4

# Response
{
  "id": 4,
  "issuer": "GCJUKU...A6V4",
  "counterparty": "GB4UFB...HHZX",
  "terms_hash": "sha256:...",
  "due_at": 1722912000,
  "status": "Pending",
  "outcome": null
}`}</pre>
            </div>
          </section>

          <div className="docs-divider" />

          {/* ── SDK ── */}
          <section id="sdk" className="docs-section">
            <div className="docs-eyebrow">{t('common.integration')}</div>
            <h2 className="docs-h1">{t('docs.sdk.title')}</h2>
            <div className="docs-callout docs-callout-info">
              <div className="docs-callout-icon">ℹ</div>
              <div>
                The SDK is in active development. Contributions welcome — see the{' '}
                <code>sdk/js/</code> directory.
              </div>
            </div>
            <pre className="docs-code">{`import { PactumClient } from '@pactum/sdk';

const client = new PactumClient({
  network: 'testnet',
  contractId: 'CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E',
});

// Check reputation before entering a deal
const rep = await client.getReputation('GCJUKU...A6V4');
console.log(rep);
// { fulfilled: 14, late: 2, breached: 1, total: 17 }

// Create a commitment
const id = await client.createCommitment({
  issuer:       'GCJUKU...A6V4',
  counterparty: 'GB4UFB...HHZX',
  terms:        'Refund deposit within 30 days of move-out.',
  dueAt:        new Date('2024-09-01'),
});`}</pre>
          </section>

          <div className="docs-divider" />

          {/* ── Local Dev ── */}
          <section id="localdev" className="docs-section">
            <div className="docs-eyebrow">{t('common.integration')}</div>
            <h2 className="docs-h1">{t('docs.deployment.localDev')}</h2>
            <p>{t('docs.deployment.prerequisites')}</p>
            <pre className="docs-code">{`# 1. Clone
git clone https://github.com/amankoli09/Pactum.git
cd Pactum

# 2. Build & test the Soroban contract
cd contracts && cargo test

# 3. Set up the backend
cd ../backend
npm install
cp .env.example .env   # fill in DATABASE_URL, SOROBAN_RPC_URL, etc.
npm run migrate:latest
npm run dev

# 4. Run the frontend
cd ../frontend
npm install
npm run dev`}</pre>
          </section>

          <div className="docs-divider" />

          {/* ── Roadmap ── */}
          <section id="roadmap" className="docs-section">
            <div className="docs-eyebrow">{t('common.contribute')}</div>
            <h2 className="docs-h1">{t('docs.roadmap.title')}</h2>
            <div className="docs-roadmap">
              {[
                {
                  done: true,
                  item: 'Core registry contract — create / attest / dispute / resolve',
                },
                { done: true, item: 'Per-address reputation aggregation on-chain' },
                { done: true, item: 'Full test suite including dispute edge cases' },
                { done: true, item: 'React dashboard for creating and managing commitments' },
                { done: false, item: 'Oracle-based auto-attestation for measurable commitments' },
                {
                  done: false,
                  item: 'Commitment templates (refund, SLA, milestone, recurring report)',
                },
                { done: false, item: 'Public reputation lookup REST API' },
                { done: false, item: 'JS/TS SDK (@pactum/sdk)' },
                { done: false, item: 'Backend indexer for event aggregation' },
                { done: false, item: 'Multi-arbitrator support' },
                { done: false, item: 'Rate limiting & spam-commitment protections' },
              ].map((r) => (
                <div className="docs-roadmap-item" key={r.item}>
                  <span className={`docs-roadmap-check ${r.done ? 'done' : ''}`}>
                    {r.done ? '✓' : '○'}
                  </span>
                  <span className={r.done ? '' : 'docs-roadmap-pending'}>{r.item}</span>
                </div>
              ))}
            </div>
          </section>

          <div className="docs-divider" />

          {/* ── Contributing ── */}
          <section id="contributing" className="docs-section">
            <div className="docs-eyebrow">Contributing</div>
            <h2 className="docs-h1">How to Contribute</h2>
            <p>
              We're actively opening scoped issues for contributors across Rust/Soroban, TypeScript
              backend, and frontend work.
            </p>
            <div className="docs-callout docs-callout-success">
              <div className="docs-callout-icon">✓</div>
              <div>
                Open issues are tagged by skill area. Check the{' '}
                <a
                  href="https://github.com/amankoli09/Pactum/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="docs-link"
                >
                  GitHub Issues
                </a>{' '}
                to find one that fits.
              </div>
            </div>
            <p>
              See{' '}
              <a
                href="https://github.com/amankoli09/Pactum/blob/main/CONTRIBUTING.md"
                target="_blank"
                rel="noopener noreferrer"
                className="docs-link"
              >
                CONTRIBUTING.md
              </a>{' '}
              for local setup, coding conventions, and PR process.
            </p>

            <div className="docs-cta-bar">
              <button className="docs-cta-btn" onClick={onLaunchApp}>
                {t('landing.nav.launchApp')} →
              </button>
              <a
                href="https://github.com/amankoli09/Pactum"
                target="_blank"
                rel="noopener noreferrer"
                className="docs-cta-link"
              >
                {t('docs.viewOnGitHub')} ↗
              </a>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
