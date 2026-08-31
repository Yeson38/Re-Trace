/// <reference types="vite/client" />

// Allow dynamic import of external CDN URLs (Pyodide)
declare module "https://*" {
  const mod: any;
  export = mod;
}

// Allow optional Wasmer SDK imports
declare module "@wasmer/wasi" {
  const WASI: any;
  export default WASI;
}
declare module "@wasmer/wasmfs" {
  const WasmFs: any;
  export default WasmFs;
}
