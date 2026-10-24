---
'@ixo/oracle-runtime-workers': minor
---

Add shell-free capsule inspection and a fail-closed contract check before CID-based skill loading and execution. Legacy capsules become reference-only through this gate. Private skill reads require a current private audience. Sandbox discovery no longer forwards user or oracle secret values.
