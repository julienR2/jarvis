/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin serving generated apps; empty means same-origin. See api.ts. */
  readonly VITE_APPS_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
