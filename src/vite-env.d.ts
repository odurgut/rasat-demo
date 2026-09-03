/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
