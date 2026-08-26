/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SOROBAN_RPC_URL?: string;
  readonly VITE_PACTUM_CONTRACT_ID?: string;
  readonly VITE_STELLAR_NETWORK_PASSPHRASE?: string;
  readonly VITE_ALBEDO_NETWORK?: string;
  readonly VITE_WEB3AUTH_CLIENT_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
