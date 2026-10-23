The vendored `@ixo/action-protocol` package is packed from the Auth Hub
`packages/action-protocol` source in the coordinated channel-action branch.
The root workspace override resolves `@ixo/action-protocol@0.4.0` to this
archive for local validation. The published runtime manifest names version
`0.4.0`; release requires the reviewed shared package to be published first.
It contains the shared parser and types; QiForge does not maintain a copy of
its wire schemas.

Tarball: `ixo-action-protocol-0.4.0-d188ba9c.tgz` (Auth Hub
`qi/channels-services-p2` @ `0ba7abb`, `packages/action-protocol`)

SHA-256: `d188ba9cfca0f97c0ee37e838bb5eb1703cb12ed35c1f92a6101b945d4e6a0fb`

Before release, repack from the reviewed Auth Hub commit and update this digest,
the tarball, and `pnpm-lock.yaml` together.
