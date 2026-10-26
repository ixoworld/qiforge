The vendored `@ixo/action-protocol` package is packed from the Auth Hub
`packages/action-protocol` source in the coordinated channel-action branch.
The root workspace override resolves `@ixo/action-protocol@0.4.1` to this
archive for local validation. The published runtime manifest names version
`0.4.1`; release requires the reviewed shared package to be published first.
It contains the shared parser and types; QiForge does not maintain a copy of
its wire schemas.

Tarball: `ixo-action-protocol-0.4.1-e16ca342.tgz` (Auth Hub
`qi/channels-services-p2` @ `7a503ce`, `packages/action-protocol`)

SHA-256: `e16ca342a139c0ebd3b2c0b7814d799a7f12c75aed95c22d01ec9cf143a456f7`

Before release, repack from the reviewed Auth Hub commit and update this digest,
the tarball, and `pnpm-lock.yaml` together.
