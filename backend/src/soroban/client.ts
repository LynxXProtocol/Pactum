import {
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative
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
  async attestCommitment(
    commitmentId: number,
    outcome: CommitmentStatus
  ): Promise<string> {
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
            nativeToScVal(outcome, { type: 'u32' })
          )
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
      throw new Error(`Failed to attest commitment: ${error instanceof Error ? error.message : String(error)}`);
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
          this.contract.call(
            'get_commitment',
            nativeToScVal(commitmentId, { type: 'u64' })
          )
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
      throw new Error(`Failed to get commitment: ${error instanceof Error ? error.message : String(error)}`);
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
          this.contract.call(
            'is_overdue',
            nativeToScVal(commitmentId, { type: 'u64' })
          )
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
      throw new Error(`Failed to check if commitment is overdue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Read-only calls are simulated, never submitted, so a zero-sequence stub
   * account is enough to build the envelope.
   */
  private readOnlyAccount(): Account {
    return new Account(this.keypair.publicKey(), '0');
  }
}
