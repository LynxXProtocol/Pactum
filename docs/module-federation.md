# Frontend Micro-Frontends: Module Federation

Status: implemented (tracking issue #154). This document explains how the frontend is split into
independently compiled and deployed applications using [Vite Module
Federation](https://module-federation.io/integrations/build-tool/vite), and — the part that's easy
to silently get wrong — how `WalletContext` and the React Query cache are shared as true runtime
singletons across the module boundary rather than duplicated per bundle.

## Why

As Pactum grows to include governance, staking, and identity modules, a single monolithic Vite
build becomes a shared deployment and performance bottleneck: every team touching any feature
rebuilds and redeploys the whole app, and the whole app's JS ships to every visitor regardless of
which page they're on. Module Federation lets each feature area be its own Vite app, built and
deployed on its own schedule, and stitched together in the browser at runtime by the host.

## Packages

```
frontend/                    # host / container application
frontend-dashboard-remote/   # remote: exposes ReputationDashboard
frontend-wizard-remote/      # remote: exposes CreateCommitmentWizard
```

Each is a fully independent Vite project with its own `package.json`, dependencies, dev server,
and build output — genuinely independently compiled and deployed, not just independently
organized source folders that still ship in one bundle.

- **`frontend/` (host)** owns the app shell (landing page, docs, sidebar/navigation — see
  `src/App.tsx`), and dynamically loads the two remotes' components into the pages that need them.
  It also owns and exposes the two things every remote needs to share: `WalletContext`
  (`src/contexts/WalletContext.tsx`) and the `QueryClient` instance (`src/lib/queryClient.ts`).
- **`frontend-dashboard-remote/`** exposes `ReputationDashboard` (moved from
  `frontend/src/components/`, unchanged logic) as `dashboard/ReputationDashboard`.
- **`frontend-wizard-remote/`** exposes `CreateCommitmentWizard` (moved the same way) as
  `wizard/CreateCommitmentWizard`.

## Loading a remote from the host

`frontend/src/App.tsx` loads both remotes with ordinary `React.lazy` + `Suspense`, exactly as it
would for local code-splitting — Module Federation's Vite plugin makes `import('dashboard/...')`
resolve to a runtime fetch of the remote's `remoteEntry.js` instead of a local chunk:

```tsx
const ReputationDashboard = lazy(() => import('dashboard/ReputationDashboard'))
const CreateCommitmentWizard = lazy(() => import('wizard/CreateCommitmentWizard'))
```

Each usage site is wrapped in `RemoteErrorBoundary` (`src/components/RemoteErrorBoundary.tsx`), so
a remote that's down, still deploying, or failing to load degrades to a retryable inline warning
instead of white-screening the rest of the host (exercised by the last test in
`tests/e2e/module-federation.spec.ts`).

## Two different sharing mechanisms, used deliberately

This is the part of the setup most likely to be gotten subtly wrong, so it's worth being explicit
about which mechanism is used for what, and why:

### `shared`: real npm packages, deduplicated by Module Federation

`react`, `react-dom`, and `@tanstack/react-query` are declared `shared: { singleton: true }` in
**every** package's `vite.config.ts` (host and both remotes). This tells Module Federation's
runtime: don't let each bundle load its own copy of this package — negotiate a single shared copy
across the whole federation at runtime. This matters for more than bundle size: React's hooks and
`@tanstack/react-query`'s `useQuery`/`useQueryClient` all read off a React Context created by
their respective package. If a remote bundled its own copy instead of sharing, it would create a
*second*, un-Provided context — `useContext` there would silently see the default value (or throw)
instead of the value the host's Provider actually supplies, even though everything otherwise looks
correctly wired.

### `exposes` / `remotes`: application code, consumed as federated modules

`WalletContext` and `queryClient` are not npm packages — they're this app's own code, so they
can't be deduplicated by package name. Instead, the host `exposes` them (`vite.config.ts`) and
each remote declares the host as a `remotes` dependency and imports them by federated specifier:

```ts
// frontend-dashboard-remote/src/ReputationDashboard.tsx
import { useWallet } from 'host/WalletContext'
```

This is a genuinely different module resolution path than a relative import — `host/WalletContext`
resolves, at runtime, to the *one* `WalletContext.tsx` module instance the host's
`<WalletProvider>` already rendered, not a separately bundled copy. Sharing the `queryClient`
*instance* this way is necessary even with `@tanstack/react-query` itself deduplicated via
`shared`: deduplicating the package doesn't stop two apps from each calling `new QueryClient()`
independently and getting two different caches. Both mechanisms are needed together.

TypeScript can't see through `host/WalletContext` or `dashboard/ReputationDashboard` statically
(they don't exist as real files from its perspective), so each package hand-maintains a narrow
`src/remotes.d.ts` ambient declaration for exactly the exports it imports, instead of relying on
Module Federation's optional automatic type-generation (`dts: false` in every `vite.config.ts` —
we chose the explicit, narrower alternative so a real drift between an exposed module's actual API
and what a consumer assumes shows up as a type error at the declaration site).

## Verifying the sharing is real, not just configured

`frontend/tests/e2e/module-federation.spec.ts` runs the host and both remotes together in a real
browser and proves singleton sharing by **referential identity**, not behavior:

- `WalletContext.tsx` generates a random `contextModuleId` exactly once, when the module is first
  evaluated, and includes it in the context value. The host's `WalletProvider` records its id on
  `window` in dev; both remotes record the id they observe via `useWallet()` the same way. The
  test asserts all three are the *same* id — if either remote had bundled its own copy of
  `WalletContext.tsx` instead of consuming the host's exposed one, this would fail (either
  `useWallet()` throws with no Provider in that copy's tree, or, if it somehow rendered, the id
  simply wouldn't match).
- Similarly, the host's `queryClient.ts` records its `QueryClient` instance on `window`; the
  dashboard remote reads its client via `useQueryClient()` — React Query's own Context hook, not
  the direct `host/queryClient` import used elsewhere — and records what it saw. The test asserts
  `===` identity, which proves both that the client instance is shared *and* that
  `@tanstack/react-query`'s `shared: { singleton: true }` config is actually deduplicating the
  package (a duplicated copy would read a different Context entirely).

These `window.__PACTUM_*` markers are only ever set behind `import.meta.env.DEV`, so none of this
ships in production builds.

## Running it locally

Each package needs its own `npm install`. Then, three terminals:

```bash
cd frontend-dashboard-remote && npm run dev   # http://localhost:5174
cd frontend-wizard-remote && npm run dev      # http://localhost:5175
cd frontend && npm run dev                    # http://localhost:5173 — open this one
```

The host's dev server must resolve both remotes' `remoteEntry.js` to render the Reputation
Lookup and Create Commitment pages; if a remote isn't running, the host still loads and the
affected page shows the `RemoteErrorBoundary` fallback instead of failing entirely.

`npm run test:e2e` in `frontend/` starts all three dev servers automatically (see
`playwright.config.ts`'s array `webServer` config) and runs the full Playwright suite, including
`module-federation.spec.ts`.

## Production builds and deployment

`npm run build` in each package produces an independent, deployable `dist/`. The host's remote
entry URLs are environment-configured, not hardcoded (`frontend/vite.config.ts` reads
`VITE_DASHBOARD_REMOTE_URL` / `VITE_WIZARD_REMOTE_URL`, falling back to the local dev ports — see
`frontend/.env.example`), so a remote can be redeployed to a new URL — a new version, a CDN
migration, a canary — without rebuilding or redeploying the host.

## Adding a future remote

The issue that motivated this work names governance, staking, and identity as upcoming modules.
Each should follow the same shape as `frontend-dashboard-remote/`: its own `package.json` and
`vite.config.ts` (`exposes` its component(s), `remotes: { host }`, and the same `shared`
singleton block for `react`/`react-dom`/`@tanstack/react-query`), consume `WalletContext` and
`queryClient` from `host/...` rather than reimplementing or reinstantiating them, and be registered
in the host's `vite.config.ts` `remotes` map and loaded via `React.lazy` + `RemoteErrorBoundary` in
`App.tsx`.
