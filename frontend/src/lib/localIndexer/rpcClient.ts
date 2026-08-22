import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

import type { LocalIndexerRpcClient } from './poller';

export interface SorobanIndexerRpcClientConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
}

/** A throwaway, never-funded, never-signing source account — required by the SDK to build a simulate-only read call. */
function readOnlyAccount(): Account {
  return new Account(Keypair.random().publicKey(), '0');
}

/** Real Soroban RPC-backed implementation of `LocalIndexerRpcClient`, used by `indexer.worker.ts`. */
export function createSorobanIndexerRpcClient(
  config: SorobanIndexerRpcClientConfig,
): LocalIndexerRpcClient {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: true });
  const contract = new Contract(config.contractId);

  return {
    async getLatestLedger() {
      const ledger = await server.getLatestLedger();
      return { sequence: ledger.sequence };
    },

    async getEvents(request) {
      const response = await server.getEvents(request);
      return {
        events: response.events.map((event) => ({ topic: event.topic, value: event.value })),
        cursor: response.cursor,
      };
    },

    async getCommitment(id) {
      const transaction = new TransactionBuilder(readOnlyAccount(), {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(contract.call('get_commitment', nativeToScVal(id, { type: 'u64' })))
        .setTimeout(30)
        .build();

      const simulation = await server.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simulation) || !simulation.result) return null;

      const value = scValToNative(simulation.result.retval);
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    },
  };
}
