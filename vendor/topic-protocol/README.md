# Worker-compatible Topic candidate

This archive is a local and CI candidate built from [Topic Protocol PR 37](https://github.com/ixoworld/topic-protocol/pull/37), exact commit `a912f8c14b4a4ea3144882ebe810b65812163715`. It precompiles JSON-schema validators at build time. The previous registry version `1.0.0-rc.7` generates code during module import, which Workers prohibit. The existing runtime boot guard remains unchanged.

The upstream PR was not merged and this package was not published as part of this change. The runtime manifest names `1.0.0-rc.8`, while the workspace override resolves this reviewed archive for source validation. **Runtime publication remains blocked until the corresponding reviewed registry package is available and verified.**

Built in a clean isolated checkout with `npm ci --ignore-scripts`, `npm run build`, then `npm pack --ignore-scripts --cache ./node_modules/.cache/npm`. Both package entry points were imported with `node --disallow-code-generation-from-strings`. No candidate source changes were made.

Archive: `ixo-topic-protocol-1.0.0-rc.8.tgz`

SHA-256: `84e6918ab94b8a8b77ff82e5af650221f86156ee0bd5db430cf8a8538c7a58a2`

Before release, verify the published artifact, remove this temporary source override and archive, regenerate the lockfile, and rerun the runtime boot guard and Worker tests against the registry artifact. A green candidate build does not approve an upstream merge, publication, or deployment.
