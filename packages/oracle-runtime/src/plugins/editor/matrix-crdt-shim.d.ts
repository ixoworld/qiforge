// The `@ixo/matrix-crdt` package ships its declarations with extensionless
// re-exports (`export * from "./MatrixProvider"`), which TypeScript rejects
// under `moduleResolution: NodeNext` even though the runtime exports work
// fine. This shim re-exports the specific symbols we need via the deep
// declaration path, sidestepping the broken top-level barrel.
declare module '@ixo/matrix-crdt' {
  export { MatrixProvider } from '@ixo/matrix-crdt/types/MatrixProvider';
  export type { MatrixProviderOptions } from '@ixo/matrix-crdt/types/MatrixProvider';
}
