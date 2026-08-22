import { Address, Contract, Networks, TransactionBuilder, BASE_FEE, rpc, xdr, Keypair } from '@stellar/stellar-sdk';

declare var console: any;

export interface CommitmentOp {
  issuerAddress: string;
  counterpartyAddress: string;
  termsHash: bigint;
  dueAt: bigint;
}

export interface BatchWitness {
  leafPos: bigint;
  siblings: bigint[];
  pathBits: (0 | 1)[];
}

export interface FraudProofInputs {
  claimedBatchRoot: bigint;
  operation: CommitmentOp;
  issuerSignature: string; // Hex string (64 bytes)
  merkleWitness: BatchWitness;
}

export class FraudProofService {
  private readonly verifierContractId: string;
  private readonly rpcUrl: string;

  constructor(verifierContractId: string, rpcUrl: string = 'https://soroban-testnet.stellar.org') {
    this.verifierContractId = verifierContractId;
    this.rpcUrl = rpcUrl;
  }

  /**
   * Called by a watcher node that detects a potentially fraudulent batch.
   * Generates a ZK proof and submits it to the Soroban verifier contract.
   */
  async challenge(
    challengerKeypair: Keypair,
    batchLedgerSeq: number,
    inputs: FraudProofInputs
  ): Promise<{ success: boolean; txHash?: string }> {

    console.log('Generating fraud proof...');
    // Dynamically import the ESM module from the zk package
    const zkModule = await import('../../../zk/scripts/generate_proof.js' as any);
    const { generateFraudProof } = zkModule;
    
    const { isFraud } = await generateFraudProof(inputs);

    if (!isFraud) {
      console.log('No fraud detected — batch state transition is correct.');
      return { success: false };
    }

    console.log('Fraud detected! Submitting proof to Soroban...');

    const server = new rpc.Server(this.rpcUrl);
    const account = await server.getAccount(challengerKeypair.publicKey());
    const contract = new Contract(this.verifierContractId);
    
    // Soroban structs represented as ScMap must have keys sorted alphabetically
    const commitmentScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('counterparty'), val: Address.fromString(inputs.operation.counterpartyAddress).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('due_at'), val: xdr.ScVal.scvU64(new xdr.Uint64(Number(inputs.operation.dueAt))) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('issuer'), val: Address.fromString(inputs.operation.issuerAddress).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('terms_hash'), val: xdr.ScVal.scvBytes(Buffer.from(inputs.operation.termsHash.toString(16).padStart(64, '0'), 'hex')) }),
    ]);

    const siblingsScVec = inputs.merkleWitness.siblings.map(sib => 
      xdr.ScVal.scvBytes(Buffer.from(sib.toString(16).padStart(64, '0'), 'hex'))
    );
    const pathBitsScVec = inputs.merkleWitness.pathBits.map(bit => 
      xdr.ScVal.scvU32(bit)
    );

    const merkleProofScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('path_bits'), val: xdr.ScVal.scvVec(pathBitsScVec) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('siblings'), val: xdr.ScVal.scvVec(siblingsScVec) }),
    ]);
    
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        contract.call(
          'submit_fraud_proof',
          Address.fromString(challengerKeypair.publicKey()).toScVal(),
          xdr.ScVal.scvU32(batchLedgerSeq),
          xdr.ScVal.scvU32(Number(inputs.merkleWitness.leafPos)),
          commitmentScVal,
          merkleProofScVal
        )
      )
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);
    console.log(`Estimated CPU instructions: ${(simResult as any).cost?.cpuInsns}`);

    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(challengerKeypair);
    const response = await server.sendTransaction(preparedTx);

    return { success: true, txHash: response.hash };
  }
}
