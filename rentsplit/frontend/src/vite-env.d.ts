/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_RELAYER_FEE_BUFFER_USDC?: string;
  readonly VITE_BASE_BUILDER_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
