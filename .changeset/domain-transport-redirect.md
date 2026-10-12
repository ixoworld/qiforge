---
'@ixo/oracle-runtime-workers': patch
---

Domain context resolved every anchor as `unavailable` / `resolution-failed` on Cloudflare: the transport asked `fetch` for `redirect: 'error'`, which workerd refuses with a TypeError before any network call. Requests are now made with `redirect: 'manual'` and a 3xx answer is refused by the transport itself (`iid-unavailable` for the Blocksync lookup, the new `document-redirect-refused` for a document read), so redirects are still never followed. A resolution failure that is not a finding code is now logged as `[domain-context] resolution of <did> failed: <message>`. The transport accepts an injected `fetch`, and a workerd test drives it through a loopback service binding so the request options reach the real runtime.
