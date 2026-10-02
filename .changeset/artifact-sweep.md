---
'@ixo/oracle-runtime-workers': patch
---

Expired artefact share copies are swept from R2 by the cron.

- **Sweep.** The cron tick of the script that binds `ARTIFACT_BUCKET` deletes share copies under `art/` whose `expiresAt` has passed, including the ones nobody opens again. It lists with custom metadata (no per-object read), deletes up to 1,000 keys per call, and lists at most 20 pages per tick; a larger bucket is finished over the next ticks from a stored cursor. Copies without a readable `expiresAt` are left alone.
- **Throttle.** A full sweep starts every `ARTIFACT_SWEEP_INTERVAL_HOURS` (24 by default, 1 to 168, validated at boot). Between sweeps a tick costs one R2 read and logs nothing; a sweep logs one summary line per tick. State lives in `artifact-sweep/state`, outside `art/`.
- **Cron.** The sweep needs a cron trigger on the script that binds the bucket. The single-script layout's keep-alive cron covers it; in a gateway split, give the oracle script one (daily is enough). The keep-alive still runs first, and a failed keep-alive no longer skips the sweep.
- An R2 lifecycle rule on `art/` is now optional. If you keep one, set it to `ARTIFACT_LINK_TTL_DAYS + 1` days.
