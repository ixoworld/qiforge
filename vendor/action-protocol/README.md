The vendored `@ixo/action-protocol` package is packed from the Auth Hub
`packages/action-protocol` source in the coordinated channel-action branch.
The root workspace override resolves `@ixo/action-protocol@0.2.0` to this
archive for local validation. The published runtime manifest names version
`0.2.0`; release requires the reviewed shared package to be published first.
It contains the shared parser and types; QiForge does not maintain a copy of
its wire schemas.

Tarball: `ixo-action-protocol-0.2.0.tgz`

SHA-256: `fda617eefaee75f353d1cb9191c349810063b7ed4a3e0a2f14fef6c0309bccb0`

Before release, repack from the reviewed Auth Hub commit and update this digest,
the tarball, and `pnpm-lock.yaml` together.
