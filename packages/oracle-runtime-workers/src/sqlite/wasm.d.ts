/**
 * `.wasm` imports are `CompiledWasm` modules on workerd (wrangler's default
 * module rule and the Workers vitest pool both apply it). The import yields a
 * ready `WebAssembly.Module`, so no runtime compilation happens — which is
 * required, because workerd forbids `WebAssembly.compile` / `new Module(bytes)`.
 */
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
