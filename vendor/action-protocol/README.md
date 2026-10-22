The vendored `@ixo/action-protocol` package is packed from the Auth Hub
`packages/action-protocol` source in the coordinated channel-action branch.
The root workspace override resolves `@ixo/action-protocol@0.3.0` to this
archive for local validation. The published runtime manifest names version
`0.3.0`; release requires the reviewed shared package to be published first.
It contains the shared parser and types; QiForge does not maintain a copy of
its wire schemas.

Tarball: `ixo-action-protocol-0.3.0-8f5d4ea1.tgz`

SHA-256: `8f5d4ea1c42b95aba0b1ce4035b9e1ecc0422f269933f8f9f0ac31c43fc7cbed`

Before release, repack from the reviewed Auth Hub commit and update this digest,
the tarball, and `pnpm-lock.yaml` together.
