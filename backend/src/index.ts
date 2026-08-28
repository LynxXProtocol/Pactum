import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import commitmentsRouter from './routes/commitments';
import { createReputationRouter } from './routes/reputation';
import analyticsRoutes from './routes/analytics';
import heReputationRouter from './routes/he_reputation';
import { createProofsRouter } from './routes/proofs';
import { createAttestorRouter } from './routes/attestor';
import { PostgresAttestorRepository } from './attestor/repository';
import { AttestorCache } from './attestor/cache';
import { RelayerService } from './relayer/relayerService';
import pool from './db/timescale';
import { PostgresReputationRepository } from './reputation/repository';
import { createRedisClientFromEnv, ReputationCache } from './cache/reputationCache';
import { createOpenApiRouter } from './openapi/openapi';
import { requestLogger } from './middleware/requestLogger';
import { logger } from './logger/logger';
import client from 'prom-client';
import { startTtlMonitorCron, createTtlRpcClient } from './indexer/cron';
import { SorobanClient } from './soroban/client';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { standardLimiter, strictLimiter } from './middleware/rateLimiter';

import { WebSocketService } from './ws/WebSocketService';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const metricsPort = process.env.METRICS_PORT || 9090;

// Prometheus metrics setup
const register = new client.Registry();

// HTTP request latency histogram
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Active WebSocket connections gauge (placeholder for future WebSocket implementation)
const activeWebSocketConnections = new client.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections',
  registers: [register],
});

// Collect default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// Security headers (helmet-equivalent)
// Sets HSTS, X-Content-Type-Options, X-Frame-Options, and related headers on
// every response to harden the API against common web vulnerabilities.
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction): void => {
  // Strict-Transport-Security: enforce HTTPS for 1 year, include subdomains
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Disallow framing of this page (clickjacking protection)
  res.setHeader('X-Frame-Options', 'DENY');
  // Disable legacy X-XSS-Protection header (modern browsers ignore it; setting
  // to 0 prevents a known IE vulnerability)
  res.setHeader('X-XSS-Protection', '0');
  // Restrict what can be loaded by the page
  if (req.path.startsWith('/api-docs')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' https: 'unsafe-inline'; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'",
    );
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  // Hide the server implementation detail
  res.removeHeader('X-Powered-By');
  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Prevent browsers from requesting permission-gated features
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
});

// ---------------------------------------------------------------------------
// Rate limiting
// POST / PUT / PATCH / DELETE requests use the strict limiter (10 req/min).
// All other requests (GET, HEAD, OPTIONS) use the standard limiter (100 req/min).
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction): void => {
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (writeMethods.has(req.method)) {
    strictLimiter(req, res, next);
  } else {
    standardLimiter(req, res, next);
  }
});

// ---------------------------------------------------------------------------
// Security headers (helmet-equivalent)
// Sets HSTS, X-Content-Type-Options, X-Frame-Options, and related headers on
// every response to harden the API against common web vulnerabilities.
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response, next: NextFunction): void => {
  // Strict-Transport-Security: enforce HTTPS for 1 year, include subdomains
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Disallow framing of this page (clickjacking protection)
  res.setHeader('X-Frame-Options', 'DENY');
  // Disable legacy X-XSS-Protection header (modern browsers ignore it; setting
  // to 0 prevents a known IE vulnerability)
  res.setHeader('X-XSS-Protection', '0');
  // Restrict what can be loaded by the page
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'",
  );
  // Hide the server implementation detail
  res.removeHeader('X-Powered-By');
  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Prevent browsers from requesting permission-gated features
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
});

// ---------------------------------------------------------------------------
// Rate limiting
// POST / PUT / PATCH / DELETE requests use the strict limiter (10 req/min).
// All other requests (GET, HEAD, OPTIONS) use the standard limiter (100 req/min).
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction): void => {
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (writeMethods.has(req.method)) {
    strictLimiter(req, res, next);
  } else {
    standardLimiter(req, res, next);
  }
});

app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Middleware to track HTTP request duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestDuration.labels(req.method, req.path, res.statusCode.toString()).observe(duration);
  });
  next();
});

// Health check route
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',

    timestamp: new Date().toISOString(),
  });
});

// Mount the routers
app.use('/commitments', commitmentsRouter);
const redis = createRedisClientFromEnv();
redis.on('error', (error) => console.error('Redis connection error', error));
const reputationCache = new ReputationCache(redis, new PostgresReputationRepository(pool), {
  ttlSeconds: Number(process.env.REPUTATION_CACHE_TTL_SECONDS ?? 300),
});

// Homomorphic encryption layer — Issue #190
app.use('/reputation', heReputationRouter);
app.use('/api/reputation', heReputationRouter);

// ── Soroban client (shared by reputation router + TTL monitor) ─────────────
// Built once from env so both the trust-score API endpoint and the TTL monitor
// cron use the same keypair and network configuration.
const sorobanRpcUrl = process.env.SOROBAN_RPC_URL;
const sorobanContractId = process.env.SOROBAN_CONTRACT_ID;
const sorobanPrivateKey = process.env.ORACLE_PRIVATE_KEY;
const sorobanNetworkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE;

let sharedSorobanClient: SorobanClient | undefined;
if (sorobanRpcUrl && sorobanContractId && sorobanPrivateKey && sorobanNetworkPassphrase) {
  sharedSorobanClient = new SorobanClient({
    rpcUrl: sorobanRpcUrl,
    contractId: sorobanContractId,
    networkPassphrase: sorobanNetworkPassphrase,
    privateKey: sorobanPrivateKey,
  });
}

// Pass the optional SorobanClient so the /trust-score endpoint can query
// the live chain.  The router degrades gracefully when it is undefined.
const reputationRouterInstance = createReputationRouter(reputationCache, sharedSorobanClient);
app.use('/reputation', reputationRouterInstance);
// Also mounted here because that is where the placeholder handler used to live.
app.use('/api/reputation', reputationRouterInstance);
app.use('/api/analytics', analyticsRoutes);
app.use('/api-docs', createOpenApiRouter());

const relayerService = new RelayerService({
  rpcUrl: process.env.SOROBAN_RPC_URL,
  contractId:
    process.env.REGISTRY_CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  maxBatchSize: Number(process.env.RELAYER_MAX_BATCH_SIZE) || 32,
  batchTtlMs: Number(process.env.RELAYER_BATCH_TTL_MS) || 10_000,
  persistPath: process.env.RELAYER_BATCH_QUEUE_PATH,
  autoStart: process.env.RELAYER_AUTO_START === 'on' || process.env.RELAYER_AUTO_START === '1',
});
const proofsRouter = createProofsRouter(relayerService);
app.use('/proofs', proofsRouter);
app.use('/api/proofs', proofsRouter);
app.use('/api/v1/proofs', proofsRouter);

// ── Attestor reputation & discovery engine (Issue #63) ─────────────────────
const attestorRepository = new PostgresAttestorRepository(pool);
const attestorCache = new AttestorCache(redis, attestorRepository, {
  reliabilityTtlSeconds: Number(process.env.ATTESTOR_RELIABILITY_TTL_SECONDS ?? 300),
  discoveryTtlSeconds: Number(process.env.ATTESTOR_DISCOVERY_TTL_SECONDS ?? 10),
});
app.use('/', createAttestorRouter(attestorCache, attestorRepository));

// Metrics endpoint for Prometheus scraping
app.get('/metrics', async (req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

if (process.env.INDEXER_ENABLED !== 'off') {
  // NOTE: Legacy startSnapshotCron() removed — reputation snapshots are now
  // handled natively by TimescaleDB Continuous Aggregate refresh policies
  // (see migration 007_continuous_aggregates.sql).

  // ── Soroban State Archival / TTL Monitor (Issue #58) ──────────────────
  // Proactively bumps the TTL of high-value reputation entries before they
  // reach the Soroban archive threshold, so dormant-address lookups never
  // encounter an archived-entry host rejection.
  if (sharedSorobanClient && sorobanRpcUrl) {
    const rpcServer = new SorobanRpc.Server(sorobanRpcUrl, { allowHttp: true });
    const ttlRpcClient = createTtlRpcClient(rpcServer);
    startTtlMonitorCron(ttlRpcClient, sharedSorobanClient);
  } else {
    console.warn(
      '[TTL Monitor] Skipping TTL monitor cron: SOROBAN_RPC_URL, SOROBAN_CONTRACT_ID, ' +
        'ORACLE_PRIVATE_KEY, or SOROBAN_NETWORK_PASSPHRASE is not set.',
    );
  }
}

let server: ReturnType<typeof app.listen>;
let wsService: WebSocketService | undefined;

async function init() {
  server = app.listen(port, () => {
    logger.info(`Server running on port ${port}`, { port, metricsPort });
    wsService = new WebSocketService(server);
  });
}

init();

export const stop = async () => {
  await relayerService.shutdown();
  wsService?.close();
  server?.close();
};
export default app;
