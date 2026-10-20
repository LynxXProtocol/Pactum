import {
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Operation,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

export enum CommitmentStatus {
  Pending = 0,
  Fulfilled = 1,
  Late = 2,
  Breached = 3,
  Disputed = 4,
}

export interface SorobanClientConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  privateKey: string;
}

/**
 * Result of a trust-score query that honours the new Option<u32> contract
 * return type.  `null` means the entry is archived; a number is the live score.
 */
export type TrustScoreResult = number | null;

export class SorobanClient {
  private rpc: rpc.Server;
  private contract: Contract;
  private networkPassphrase: string;
  private keypair: Keypair;

  constructor(config: SorobanClientConfig) {
    this.rpc = new rpc.Server(config.rpcUrl, { allowHttp: true });
    this.contract = new Contract(config.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.keypair = Keypair.fromSecret(config.privateKey);
  }

  /**
   * Submits an attestation transaction for a commitment
   * @param commitmentId - The ID of the commitment to attest
   * @param outcome - The outcome status (Fulfilled, Late, or Breached)
   * @returns Transaction hash
   */
  async attestCommitment(commitmentId: number, outcome: CommitmentStatus): Promise<string> {
    try {
      // Build the transaction
      const account = await this.rpc.getAccount(this.keypair.publicKey());

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'attest',
            nativeToScVal(commitmentId, { type: 'u64' }),
            nativeToScVal(outcome, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      // Simulate the transaction to get auth requirements
      const simResult = await this.rpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      // Fold the simulated auth entries and resource footprint into the transaction
      const preparedTransaction = rpc.assembleTransaction(transaction, simResult).build();

      // Sign the transaction with the server's private key
      preparedTransaction.sign(this.keypair);

      // Send the transaction
      const sendResult = await this.rpc.sendTransaction(preparedTransaction);

      if (sendResult.errorResult) {
        throw new Error(`Send error: ${sendResult.errorResult}`);
      }

      // Wait for transaction completion
      const result = await this.rpc.pollTransaction(sendResult.hash);

      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return sendResult.hash;
      } else {
        throw new Error(`Transaction failed with status: ${result.status}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to attest commitment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get commitment details from the contract
   * @param commitmentId - The ID of the commitment
   * @returns Commitment data
   */
  async getCommitment(commitmentId: number): Promise<any> {
    try {
      const transaction = new TransactionBuilder(this.readOnlyAccount(), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call('get_commitment', nativeToScVal(commitmentId, { type: 'u64' })),
        )
        .setTimeout(30)
        .build();

      const simResult = await this.rpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      if (simResult.result) {
        return scValToNative(simResult.result.retval);
      }

      throw new Error('No result returned from simulation');
    } catch (error) {
      throw new Error(
        `Failed to get commitment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if a commitment is overdue
   * @param commitmentId - The ID of the commitment
   * @returns Boolean indicating if commitment is overdue
   */
  async isOverdue(commitmentId: number): Promise<boolean> {
    try {
      const transaction = new TransactionBuilder(this.readOnlyAccount(), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call('is_overdue', nativeToScVal(commitmentId, { type: 'u64' })),
        )
        .setTimeout(30)
        .build();

      const simResult = await this.rpc.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      if (simResult.result) {
        return Boolean(scValToNative(simResult.result.retval));
      }

      throw new Error('No result returned from simulation');
    } catch (error) {
      throw new Error(
        `Failed to check if commitment is overdue: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Queries the trust score for a given Stellar address via simulation.
   *
   * Respects the contract's new `Option<u32>` return type:
   * - Returns the numeric score (0–100) when the entry is live.
   * - Returns `null` when the entry is archived.  On the live chain an archived
   *   entry is signalled by the host, not by the contract: the simulation
   *   succeeds but carries a `restorePreamble` describing the expired entries,
   *   because the host could not run the contract against them.
   *
   * @param address - The Stellar address (G…) to query.
   * @returns The trust score, or `null` if the entry is archived.
   */
  async getTrustScore(address: string): Promise<TrustScoreResult> {
    try {
      const transaction = new TransactionBuilder(this.readOnlyAccount(), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call('get_trust_score', nativeToScVal(address, { type: 'address' })),
        )
        .setTimeout(30)
        .build();

      const simResult = await this.rpc.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      // The archived-entry signal.  The host returns a restore preamble when
      // the read footprint references expired entries instead of running the
      // contract, so surface it as `null` rather than fabricating a score.
      if (rpc.Api.isSimulationRestore(simResult)) {
        return null;
      }

      if (!simResult.result) {
        throw new Error('No result returned from simulation');
      }

      // The contract now returns Option<u32>.  scValToNative maps:
      //   void / none  -> undefined / null
      //   u32 value    -> number
      const native = scValToNative(simResult.result.retval);
      if (native === undefined || native === null) {
        return null;
      }
      return Number(native);
    } catch (error) {
      throw new Error(
        `Failed to get trust score: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Restores an archived reputation entry for `address` and extends its TTL.
   *
   * The contract's `restore_reputation` is permissionless and idempotent: when
   * the entries are live it acts as a pure TTL bump, and when they are archived
   * it extends them once the host has restored them.  This method therefore
   * handles both cases:
   *
   * 1. Simulate the invoke.  If the host returns a `restorePreamble`, one or
   *    more reputation entries are archived, so submit a `RestoreFootprint`
   *    transaction (built from the preamble) to bring them back first.
   * 2. Assemble, sign, and submit the `restore_reputation(address)` invocation,
   *    which extends the entries to the full TTL window and emits
   *    `reputation_restored`.
   *
   * This is **permissionless** — the indexer's keypair pays the fee on behalf
   * of any address that has gone dormant.
   *
   * @param address - The Stellar address whose reputation to restore.
   * @returns The transaction hash of the submitted invoke transaction.
   */
  async restoreReputation(address: string): Promise<string> {
    try {
      let account = await this.rpc.getAccount(this.keypair.publicKey());

      const buildInvoke = (source: Account) =>
        new TransactionBuilder(source, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call('restore_reputation', nativeToScVal(address, { type: 'address' })),
          )
          .setTimeout(30)
          .build();

      // Step 1: simulate the invoke to discover whether the entries are
      // archived.  The host returns a `restorePreamble` instead of running the
      // contract when the footprint references expired entries.
      let simTx = buildInvoke(account);
      let simResult = await this.rpc.simulateTransaction(simTx);
      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      if (rpc.Api.isSimulationRestore(simResult)) {
        // Step 2a: restore the archived entries.  The RestoreFootprint op takes
        // the keys to restore from the preamble's Soroban transaction data.
        const restoreTx = new TransactionBuilder(account, {
          fee: simResult.restorePreamble.minResourceFee,
          networkPassphrase: this.networkPassphrase,
        })
          .setSorobanData(simResult.restorePreamble.transactionData.build())
          .addOperation(Operation.restoreFootprint({}))
          .setTimeout(30)
          .build();

        const restoreSim = await this.rpc.simulateTransaction(restoreTx);
        if (rpc.Api.isSimulationError(restoreSim)) {
          throw new Error(`Restore simulation error: ${restoreSim.error}`);
        }

        const restorePrepared = rpc.assembleTransaction(restoreTx, restoreSim).build();
        restorePrepared.sign(this.keypair);

        const restoreSend = await this.rpc.sendTransaction(restorePrepared);
        if (restoreSend.errorResult) {
          throw new Error(`Restore send error: ${restoreSend.errorResult}`);
        }
        const restoreResult = await this.rpc.pollTransaction(restoreSend.hash);
        if (restoreResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Restore transaction failed with status: ${restoreResult.status}`);
        }

        // The restore consumed a sequence number; rebuild and re-simulate the
        // invoke against the now-live entries.
        account = await this.rpc.getAccount(this.keypair.publicKey());
        simTx = buildInvoke(account);
        simResult = await this.rpc.simulateTransaction(simTx);
        if (rpc.Api.isSimulationError(simResult)) {
          throw new Error(`Simulation error: ${simResult.error}`);
        }
      }

      // Step 2b: assemble and submit the invoke.  For a live entry this is a
      // pure TTL bump; for a just-restored entry it extends the restored data.
      const preparedTransaction = rpc.assembleTransaction(simTx, simResult).build();
      preparedTransaction.sign(this.keypair);

      const sendResult = await this.rpc.sendTransaction(preparedTransaction);
      if (sendResult.errorResult) {
        throw new Error(`Send error: ${sendResult.errorResult}`);
      }

      const result = await this.rpc.pollTransaction(sendResult.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return sendResult.hash;
      }
      throw new Error(`Transaction failed with status: ${result.status}`);
    } catch (error) {
      throw new Error(
        `Failed to restore reputation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Proactively extends the TTL (rent) of a live reputation entry so it does
   * not reach the archive threshold.
   *
   * This is used by the TTL monitor to bump high-value addresses before their
   * entries expire, avoiding the more expensive restore path.  It calls
   * `restore_reputation` on the contract which is idempotent — when the entry
   * is still live it only extends the TTL and emits the event.
   *
   * @param address - The Stellar address to bump.
   * @returns The transaction hash of the submitted bump transaction.
   */
  async bumpReputationTtl(address: string): Promise<string> {
    // The contract's restore_reputation function handles both restoration and
    // TTL extension — when the entry is live it acts as a pure bump.
    return this.restoreReputation(address);
  }

  /**
   * Read-only calls are simulated, never submitted, so a zero-sequence stub
   * account is enough to build the envelope.
   */
  private readOnlyAccount(): Account {
    return new Account(this.keypair.publicKey(), '0');
  }
}
