---
'@ixo/oracle-runtime-workers': patch
---

asks: the skills list now comes from `plugins/<folder>/skills/index.json` on raw.githubusercontent.com instead of GitHub's API, which answered 403 on Cloudflare's shared IPs, so new asks skills reached no oracle. Until that file is on ixo-plugins `main`, the plugin keeps its bundled skills, as before.
