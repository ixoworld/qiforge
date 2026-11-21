---
'@ixo/ucan': major
'@ixo/oracle-runtime': patch
'@ixo/oracle-runtime-workers': patch
---

Require standalone delegation authorization to supply a capability definition
and resource so configured roots and attenuation are enforced. Add an explicit
signature-only verifier that omits capabilities, and migrate runtime consumers
to authorize every capability they use.
