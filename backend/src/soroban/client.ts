import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  Address as StellarAddress,
  Keypair
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
  private rpc: SorobanRpc.Server;
  private contract: Contract;
  private networkPassphrase: string;
  private keypair: Keypair;

  constructor(config: SorobanClientConfig) {
    this.rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: true });
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
      // Get the latest ledger info for transaction building
      const { latestLedger } = await this.rpc.getLatestLedger();
      
      // Build the transaction
      const account = await this.rpc.getAccount(this.keypair.publicKey());
      
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'attest',
            xdr.ScVal.scvU64(commitmentId),
            xdr.ScVal.scvU32(outcome)
          )
        )
        .setTimeout(30)
        .build();

      // Simulate the transaction to get auth requirements
      const simResult = await this.rpc.simulateTransaction(transaction);
      
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      // Clone the transaction and prepare it
      const preparedTransaction = TransactionBuilder.fromXDR(
        transaction.toXDR(),
        this.networkPassphrase
      );

      if (simResult.result && simResult.result.auth) {
        // Add auth entries if required
        const authEntries = simResult.result.auth.map(entry => 
          xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')
        );
        preparedTransaction.operations[0].auth = authEntries;
      }

      // Sign the transaction with the server's private key
      preparedTransaction.sign(this.keypair);

      // Send the transaction
      const sendResult = await this.rpc.sendTransaction(preparedTransaction);
      
      if (sendResult.errorResult) {
        throw new Error(`Send error: ${sendResult.errorResult}`);
      }

      // Wait for transaction completion
      const result = await this.rpc.getTransaction(sendResult.hash);
      
      if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
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
      const { latestLedger } = await this.rpc.getLatestLedger();
      
      const transaction = new TransactionBuilder(new TransactionBuilder.Account({
        publicKey: this.keypair.publicKey(),
        sequence: '0',
        increment: '0'
      }), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'get_commitment',
            xdr.ScVal.scvU64(commitmentId)
          )
        )
        .setTimeout(30)
        .build();

      const simResult = await this.rpc.simulateTransaction(transaction);
      
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      if (simResult.result && simResult.result.retval) {
        return xdr.ScVal.fromXDR(simResult.result.retval, 'base64');
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
      const { latestLedger } = await this.rpc.getLatestLedger();
      
      const transaction = new TransactionBuilder(new TransactionBuilder.Account({
        publicKey: this.keypair.publicKey(),
        sequence: '0',
        increment: '0'
      }), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'is_overdue',
            xdr.ScVal.scvU64(commitmentId)
          )
        )
        .setTimeout(30)
        .build();

      const simResult = await this.rpc.simulateTransaction(transaction);
      
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation error: ${simResult.error}`);
      }

      if (simResult.result && simResult.result.retval) {
        const result = xdr.ScVal.fromXDR(simResult.result.retval, 'base64');
        return result.b();
      }

      throw new Error('No result returned from simulation');
    } catch (error) {
      throw new Error(`Failed to check if commitment is overdue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
