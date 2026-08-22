import type { Page } from '@playwright/test';
import { xdr } from '@stellar/stellar-sdk';

/**
 * Full offline mock of the Soroban JSON-RPC surface used by
 * submitCreateCommitment() (see frontend/src/lib/soroban.ts):
 *
 *   getLedgerEntries   -> server.getAccount() sequence-number lookup
 *   simulateTransaction-> server.prepareTransaction() footprint & fees
 *   sendTransaction    -> submission acceptance
 *   getTransaction     -> polling; NOT_FOUND once, then SUCCESS with a
 *                         TransactionMetaV3 whose sorobanMeta.returnValue
 *                         carries the mocked commitment id (u64)
 *
 * Every XDR payload below was verified against the installed
 * @stellar/stellar-sdk parsers: rpc/parsers.js#parseTransactionInfo requires a
 * valid envelopeXdr / resultXdr / resultMetaXdr triple and extracts returnValue
 * from resultMetaV3().sorobanMeta().returnValue().
 *
 * NOTE (protocol 22+ SDK): SorobanTransactionData's fee field is named
 * `resourceFee` (not `refundableFee`), ext fields are their own *Ext union
 * types (e.g. AccountEntryExt(0)), int64 fields take xdr.Int64 instances,
 * Thresholds is a raw 4-byte Buffer, and Vec fields accept plain arrays
 * (e.g. cost: []).
 */

const MOCK_LEDGER = 1_000_000;
const MOCK_LEDGER_HASH = '0'.repeat(64);
const MOCK_CLOSE_TIME = 1750000000;
const MOCK_TX_HASH = 'ab'.repeat(32);

/** Builds a funded account ledger entry matching a requested LedgerKey. */
function mockAccountLedgerEntry(requestedKeyB64: string): {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
} | null {
  let accountId: xdr.AccountId | null = null;
  try {
    const parsedKey = xdr.LedgerKey.fromXDR(requestedKeyB64, 'base64');
    // NOTE: accountId() returns an xdr.AccountId instance in this SDK
    // generation -- reuse it directly instead of round-tripping through strkey.
    accountId = parsedKey.account().accountId();
  } catch {
    // Not an account ledger key (contract/claimable/etc.) -- not mocked here.
    return null;
  }

  // NOTE: soroban-rpc returns the *LedgerEntryData* here (the SDK's
  // parseRawLedgerEntries decodes it as such), NOT a full LedgerEntry wrapper.
  const entryData = new xdr.LedgerEntryData(
    'account',
    new xdr.AccountEntry({
      accountId,
      balance: xdr.Int64.fromString('1000000000'),
      seqNum: xdr.Int64.fromString('123'),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from([1, 1, 1, 1]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );

  return {
    key: requestedKeyB64,
    xdr: entryData.toXDR('base64'),
    lastModifiedLedgerSeq: MOCK_LEDGER - 10,
  };
}

function mockSorobanTransactionData(): string {
  return new xdr.SorobanTransactionData({
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 2_000_000,
      diskReadBytes: 1000,
      writeBytes: 1000,
    }),
    resourceFee: xdr.Int64.fromString('100000'),
    ext: new xdr.SorobanTransactionDataExt(0),
  }).toXDR('base64');
}

function mockSuccessTransactionMeta(commitmentId: number): string {
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [],
    contractEvents: [],
    diagnosticEvents: [],
    cpuInsns: xdr.Int64.fromString('1000'),
    memoryBytes: xdr.Int64.fromString('1000'),
    minResourceFee: xdr.Int64.fromString('100'),
    cost: [],
    returnValue: xdr.ScVal.scvU64(xdr.Uint64.fromString(String(commitmentId))),
  });
  const metaV3 = new xdr.TransactionMetaV3({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
  });
  return new xdr.TransactionMeta(3, metaV3).toXDR('base64');
}

function mockSuccessTransactionResult(): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: new xdr.TransactionResultResult('txSuccess', []),
    ext: new xdr.TransactionResultExt(0),
  }).toXDR('base64');
}

/**
 * Installs route interceptors that make the entire on-chain commitment flow
 * succeed offline. The mocked chain reports the given `commitmentId` as the
 * create_commitment contract return value.
 */
export async function installSuccessfulSorobanRpc(
  page: Page,
  opts?: { commitmentId?: number },
): Promise<void> {
  const commitmentId = opts?.commitmentId ?? 42;
  let getTransactionCalls = 0;
  let submittedEnvelopeB64 = '';

  // Defensive: friendbot should never be reached (accounts are pre-funded),
  // but answer OK so a failed lookup cannot trigger a real network call.
  await page.route(/friendbot\.stellar\.org/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route(/soroban-testnet\.stellar\.org/, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }

    const body = request.postDataJSON() as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const respond = (result: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }),
      });

    switch (body.method) {
      case 'getLatestLedger': {
        await respond({
          sequence: MOCK_LEDGER,
          id: MOCK_LEDGER_HASH,
          protocolVersion: 22,
          latestLedger: MOCK_LEDGER,
          latestLedgerCloseTime: MOCK_CLOSE_TIME,
          oldestLedger: MOCK_LEDGER - 60,
          oldestLedgerCloseTime: MOCK_CLOSE_TIME - 3600,
        });
        return;
      }

      case 'getLedgerEntries': {
        const keys = ((body.params?.keys as string[] | undefined) ?? []).map(
          (k) => mockAccountLedgerEntry(k),
        );
        await respond({ entries: keys.filter(Boolean), latestLedger: MOCK_LEDGER });
        return;
      }

      case 'simulateTransaction': {
        await respond({
          transactionData: mockSorobanTransactionData(),
          minResourceFee: '10000',
          results: [{ auth: [], xdr: xdr.ScVal.scvBool(true).toXDR('base64') }],
          events: [],
          cpuInsns: '1000000',
          memoryBytes: '1000000',
          latestLedger: MOCK_LEDGER,
        });
        return;
      }

      case 'sendTransaction': {
        submittedEnvelopeB64 = String(body.params?.transaction ?? '');
        await respond({
          hash: MOCK_TX_HASH,
          status: 'PENDING',
          errorResultXdr: undefined,
          diagnosticEventsXdr: undefined,
          latestLedger: MOCK_LEDGER,
          latestLedgerCloseTime: MOCK_CLOSE_TIME,
        });
        return;
      }

      case 'getTransaction': {
        getTransactionCalls++;
        if (getTransactionCalls === 1) {
          await respond({
            status: 'NOT_FOUND',
            latestLedger: MOCK_LEDGER,
            latestLedgerCloseTime: MOCK_CLOSE_TIME,
            oldestLedger: MOCK_LEDGER - 60,
            oldestLedgerCloseTime: MOCK_CLOSE_TIME - 3600,
          });
          return;
        }
        await respond({
          status: 'SUCCESS',
          applicationOrder: 1,
          feeBump: false,
          envelopeXdr: submittedEnvelopeB64 || '',
          resultXdr: mockSuccessTransactionResult(),
          resultMetaXdr: mockSuccessTransactionMeta(commitmentId),
          ledger: MOCK_LEDGER - 5,
          createdAt: MOCK_CLOSE_TIME,
          txHash: String(body.params?.hash ?? MOCK_TX_HASH),
          events: { contractEventsXdr: [], transactionEventsXdr: [] },
          latestLedger: MOCK_LEDGER,
          latestLedgerCloseTime: MOCK_CLOSE_TIME,
          oldestLedger: MOCK_LEDGER - 60,
          oldestLedgerCloseTime: MOCK_CLOSE_TIME - 3600,
        });
        return;
      }

      default: {
        await respond({});
      }
    }
  });
}
