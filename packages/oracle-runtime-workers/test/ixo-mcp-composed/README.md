# Verify Auth Hub and QiForge together

Run this local proof after building both checkouts and installing their locked dependencies. Pass the Auth Hub worker directory and an output JSON path.

```sh
node test/ixo-mcp-composed/run.mjs /absolute/path/to/ixo-auth-hub/ixo-auth-worker /tmp/stage7-composed-result.json
```

The proof bundles the real Auth Hub application, applies every D1 migration in local workerd, and sends real signed access tokens through the official SDK client and server. The runtime uses its existing shared handlers and signs UCANs that the controlled subscriptions worker cryptographically verifies. The fixture routes exist only in these test entries and require local-only bindings and a fixture control secret. This script neither configures nor contacts a hosted service.

Assertions cover current resource and client registrations, token signature, account eligibility, same-grant re-consent, native withdrawal, shared disclosure, parent expiry and revocation during source execution. Results record bundle hashes, source invocations and behavior groups. Native delegation and disclosure readers are controlled fixtures, and balances are synthetic. The owner class and Worker routing have separate workerd tests. This proof does not establish hosted client acceptance or deployment readiness.
