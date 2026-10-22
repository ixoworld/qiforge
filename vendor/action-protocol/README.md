The vendored `@ixo/action-protocol` package is packed from the Auth Hub
`packages/action-protocol` source in the coordinated channel-action branch.
The root workspace override resolves `@ixo/action-protocol@0.1.0` to this
archive for local validation. The published runtime manifest names version
`0.1.0`; release requires the reviewed shared package to be published first.
It contains the shared parser and types; QiForge does not maintain a copy of
its wire schemas.

Tarball: `ixo-action-protocol-0.1.0.tgz`

SHA-256: `389e7402d35180aafafd250fde12689097e5156266026d0a35a32cdb6fed3835`

Before release, repack from the reviewed Auth Hub commit and update this digest,
the tarball, and `pnpm-lock.yaml` together.
