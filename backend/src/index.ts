import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { Horizon } from '@stellar/stellar-sdk';
import commitmentsRouter from './routes/commitments';
import reputationRouter from './routes/reputation';
import analyticsRoutes from './routes/analytics';
import { startSnapshotCron } from './indexer/cron';
import { closeCache, initCache, isCacheAvailable } from './indexer/cache';
import { standardLimiter, strictLimiter } from './middleware/rateLimiter';
import pool from './db/timescale';
import { HorizonSSEIndexer, HorizonStreamClient, HorizonOperationRecord, BroadcastEvent } from './indexer/listener';
import { PostgresCursorCache } from './indexer/cache';
import { socketService } from './socket';
import { SorobanClient } from './soroban/client';

let registryClient: SorobanClient | null | undefined;

/** Lazily builds the read-only Soroban client used to resolve attest parties. `undefined` means "not yet attempted", `null` means "env vars missing". */
function getRegistryClient(): SorobanClient | null {
  if (registryClient !== undefined) return registryClient;

  const { SOROBAN_RPC_URL, SOROBAN_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE, ORACLE_PRIVATE_KEY } = process.env;
  if (!SOROBAN_RPC_URL || !SOROBAN_CONTRACT_ID || !SOROBAN_NETWORK_PASSPHRASE || !ORACLE_PRIVATE_KEY) {
    console.error('[indexer] Soroban RPC env vars missing; attest events will not resolve broadcast addresses.');
    registryClient = null;
    return registryClient;
  }

  registryClient = new SorobanClient({
    rpcUrl: SOROBAN_RPC_URL,
    contractId: SOROBAN_CONTRACT_ID,
    networkPassphrase: SOROBAN_NETWORK_PASSPHRASE,
    privateKey: ORACLE_PRIVATE_KEY,
  });
  return registryClient;
}

const CREATE_FUNCTIONS = new Set(['create_commitment', 'create_milestone_commitment']);
const ATTEST_FUNCTIONS = new Set(['attest', 'attest_milestone']);

/**
 * Parses a Horizon `invoke_host_function` operation against the registry
 * contract into a BroadcastEvent. Returns undefined for anything else
 * (other operation types, other contracts, unrecognized functions).
 */
async function parseCommitmentEvent(record: HorizonOperationRecord): Promise<BroadcastEvent | void> {
  if (record.type !== 'invoke_host_function') return undefined;

  const parameters = record.parameters as Array<{ value: string }> | undefined;
  if (!Array.isArray(parameters) || parameters.length < 2) return undefined;

  const { scValToNative, xdr } = await import('@stellar/stellar-sdk');
  const decoded = parameters.map((p) => scValToNative(xdr.ScVal.fromXDR(p.value, 'base64')));
  const [contractAddress, functionName, ...args] = decoded;

  if (contractAddress !== process.env.SOROBAN_CONTRACT_ID) return undefined;

  if (CREATE_FUNCTIONS.has(functionName)) {
    const [issuer, counterparty, termsHash, dueAt] = args;
    return {
      address: [issuer, counterparty],
      event: 'CommitmentCreated',
      data: { issuer, counterparty, termsHash, dueAt },
    };
  }

  if (ATTEST_FUNCTIONS.has(functionName)) {
    const [, id, ...rest] = args; // args[0] is `caller`
    const client = getRegistryClient();
    if (!client) return undefined;

    const commitment = await client.getCommitment(Number(id));
    return {
      address: [commitment.issuer, commitment.counterparty],
      event: functionName === 'attest_milestone' ? 'MilestoneAttested' : 'Attested',
      data: { id: Number(id), outcome: rest[rest.length - 1] },
    };
  }

  return undefined;
}

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

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

// Health check route
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    cache: isCacheAvailable(),
    timestamp: new Date().toISOString(),
  });
});

// Mount the routers
app.use('/commitments', commitmentsRouter);
app.use('/reputation', reputationRouter);
// Also mounted here because that is where the placeholder handler used to live.
app.use('/api/reputation', reputationRouter);
app.use('/api/analytics', analyticsRoutes);

if (process.env.REPUTATION_SNAPSHOT_CRON !== 'off') {
  startSnapshotCron();
}

initCache().finally(() => {
  const server = http.createServer(app);

  // Initialize Socket.io
  socketService.init(server);

  // Initialize Horizon SSE Indexer
  const horizonServer = new Horizon.Server('https://horizon-testnet.stellar.org');
  const streamClient: HorizonStreamClient = {
    stream({ cursor, onMessage, onError }) {
      const builder = horizonServer.operations().limit(200);
      if (cursor) builder.cursor(cursor);
      return builder.stream({
        onmessage: (record) => onMessage(record as unknown as HorizonOperationRecord),
        onerror: onError,
      });
    },
  };

  const indexer = new HorizonSSEIndexer({
    streamClient,
    cursorCache: new PostgresCursorCache(pool),
    onEvent: async (record) => {
      try {
        return await parseCommitmentEvent(record);
      } catch (error) {
        console.error('[indexer] Failed to parse operation record:', error);
        return undefined;
      }
    },
    onBroadcast: (address, event, data) => {
      socketService.emitEvent(address, event, data);
    },
  });

  indexer.start();

  server.listen(port, () => {
    console.log(`[server]: Pactum Backend running at http://localhost:${port}`);
  });

  const shutdown = () => {
    indexer.stop();
    socketService.close();
    server.close(() => {
      closeCache().finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});

export default app;
