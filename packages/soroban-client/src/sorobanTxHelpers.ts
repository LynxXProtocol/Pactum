import { Contract, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import type { WalletProvider } from './wallet';
import { signTransactionWithLedger } from './wallet-adapters/ledger-adapter';
import {
  SorobanSimulationError,
  extractDiagnosticEventBlobs,
  resolveSorobanRpcUrls,
  DEFAULT_NETWORK_PASSPHRASE,
  DEFAULT_CONTRACT_ID,
  getOrCreatePool,
} from './soroban';
import { decodeSimulationError } from './xdrDecode';
import { RpcPoolExhaustedError } from './sorobanRpcPool';

const BASE_FEE = '100000';

export async function submitGenericSorobanTx({
  methodName,
  args,
  signerAddress,
  walletProvider = 'freighter',
  onStatusUpdate,
  rpcUrls,
  rpcUrl,
  contractId = import.meta.env.VITE_PACTUM_CONTRACT_ID || DEFAULT_CONTRACT_ID,
  networkPassphrase = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE,
}: {
  methodName: string;
  args: xdr.ScVal[];
  signerAddress: string;
  walletProvider?: WalletProvider;
  onStatusUpdate?: (msg: string) => void;
  /** Ordered list of Soroban RPC endpoints (connection pool). */
  rpcUrls?: string[];
  /** @deprecated Use `rpcUrls`. */
  rpcUrl?: string;
  contractId?: string;
  networkPassphrase?: string;
}) {
  onStatusUpdate?.('Initializing Soroban RPC connection pool...');
  const pool = getOrCreatePool(resolveSorobanRpcUrls(rpcUrls, rpcUrl), onStatusUpdate);

  onStatusUpdate?.('Fetching sequence number for account...');
  let account: any = null;
  try {
    account = await pool.getAccount(signerAddress);
  } catch {
    throw new Error(
      `Connected account (${signerAddress.substring(0, 8)}...) is not funded on Stellar Testnet.`,
    );
  }

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(methodName, ...args))
    .setTimeout(60)
    .build();

  onStatusUpdate?.('Simulating transaction on Soroban RPC...');
  let preparedTx: Awaited<ReturnType<typeof pool.prepareTransaction>>;
  try {
    preparedTx = await pool.prepareTransaction(tx);
  } catch (prepareErr: unknown) {
    if (prepareErr instanceof RpcPoolExhaustedError) throw prepareErr;
    const errMsg = prepareErr instanceof Error ? prepareErr.message : String(prepareErr);
    const diagBlobs = extractDiagnosticEventBlobs({ error: errMsg });
    const decoded = decodeSimulationError(errMsg, diagBlobs, methodName);
    throw new SorobanSimulationError(
      decoded.message ?? `Transaction simulation failed: ${errMsg}`,
      errMsg,
      diagBlobs,
      methodName,
    );
  }
  const unsignedXdr = preparedTx.toXDR();

  let signedXdr = '';
  if (walletProvider === 'ledger') {
    onStatusUpdate?.('Awaiting signature on Ledger device...');
    signedXdr = await signTransactionWithLedger(unsignedXdr, networkPassphrase);
  } else if (walletProvider === 'web3auth') {
    onStatusUpdate?.('Signing with your social-login Stellar key...');
    const { signTransactionWithWeb3Auth } = await import('./web3auth');
    signedXdr = signTransactionWithWeb3Auth(unsignedXdr, networkPassphrase);
  } else {
    onStatusUpdate?.('Awaiting signature in Freighter wallet...');
    const signResult = await signTransaction(unsignedXdr, {
      networkPassphrase,
      address: signerAddress,
    });
    if (typeof signResult === 'string') signedXdr = signResult;
    else if (signResult && typeof signResult === 'object') {
      if ((signResult as any).error)
        throw new Error(`Freighter signing rejected: ${(signResult as any).error}`);
      signedXdr = (signResult as any).signedTxXdr || (signResult as any).signedXdr || '';
    }
  }

  if (!signedXdr) throw new Error('Transaction signing was cancelled.');

  onStatusUpdate?.('Submitting transaction to Stellar Testnet...');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const sendResult = await pool.sendTransaction(signedTx);
  if (sendResult.status === 'ERROR' || sendResult.errorResult) {
    let formattedErr = sendResult.errorResult;
    if (formattedErr && typeof (formattedErr as any).toXDR === 'function') {
      formattedErr = (formattedErr as any).toXDR('base64');
    }
    throw new Error(
      `RPC submission error: ${formattedErr || sendResult.errorResultXdr || sendResult.status}`,
    );
  }

  const txHash = sendResult.hash;
  onStatusUpdate?.(`Transaction submitted! Confirming hash ${txHash.substring(0, 10)}...`);

  let txStatus: rpc.Api.GetTransactionStatus = rpc.Api.GetTransactionStatus.NOT_FOUND;
  let txResult: rpc.Api.GetTransactionResponse | null = null;
  let attempts = 0;
  while (attempts < 25) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      txResult = await pool.getTransaction(txHash);
    } catch (err) {
      if (err instanceof RpcPoolExhaustedError) continue;
      throw err;
    }
    txStatus = txResult.status;
    if (txStatus === rpc.Api.GetTransactionStatus.SUCCESS) break;
    else if (txStatus === rpc.Api.GetTransactionStatus.FAILED) {
      const failedTx = txResult as rpc.Api.GetFailedTransactionResponse | null;
      let diagBlobs: string[] = [];
      if (failedTx?.diagnosticEventsXdr) {
        diagBlobs = failedTx.diagnosticEventsXdr
          .map((e: any) => {
            try {
              return (e as any).toXDR?.('base64') ?? String(e);
            } catch {
              return null;
            }
          })
          .filter((b: string | null): b is string => b !== null);
      }
      throw new SorobanSimulationError(
        `Transaction execution failed on Stellar Testnet. Hash: ${txHash}`,
        `Transaction execution failed on Stellar Testnet. Hash: ${txHash}`,
        diagBlobs,
        methodName,
      );
    }
  }

  if (txStatus !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction confirmation timed out. Hash: ${txHash}`);
  }

  onStatusUpdate?.('Transaction confirmed successfully on-chain!');
  return { hash: txHash, status: 'SUCCESS' };
}

export async function submitAttest(
  id: number,
  outcome: string,
  signer: string,
  provider: WalletProvider,
  onStatusUpdate?: (msg: string) => void,
) {
  const args = [
    xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())),
    xdr.ScVal.scvSymbol(outcome),
  ];
  return submitGenericSorobanTx({
    methodName: 'attest',
    args,
    signerAddress: signer,
    walletProvider: provider,
    onStatusUpdate,
  });
}

export async function submitDispute(
  id: number,
  reason: string,
  signer: string,
  provider: WalletProvider,
  onStatusUpdate?: (msg: string) => void,
) {
  const args = [
    xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())),
    xdr.ScVal.scvString(reason),
  ];
  return submitGenericSorobanTx({
    methodName: 'dispute',
    args,
    signerAddress: signer,
    walletProvider: provider,
    onStatusUpdate,
  });
}

export async function submitResolve(
  id: number,
  outcome: string,
  signer: string,
  provider: WalletProvider,
  onStatusUpdate?: (msg: string) => void,
) {
  const args = [
    xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())),
    xdr.ScVal.scvSymbol(outcome),
  ];
  return submitGenericSorobanTx({
    methodName: 'resolve_dispute',
    args,
    signerAddress: signer,
    walletProvider: provider,
    onStatusUpdate,
  });
}

export async function submitInitRegistry(
  signer: string,
  provider: WalletProvider,
  onStatusUpdate?: (msg: string) => void,
) {
  return submitGenericSorobanTx({
    methodName: 'init',
    args: [],
    signerAddress: signer,
    walletProvider: provider,
    onStatusUpdate,
  });
}
