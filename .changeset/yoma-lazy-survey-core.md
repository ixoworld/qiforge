---
'@ixo/oracle-runtime-workers': patch
---

Yoma plugin: load `survey-core` on the first Yoma tool call instead of at Worker startup. Its module body (every SurveyJS question class registered as it runs) no longer counts against the Workers startup-time limit, which an oracle with the plugin was close to exceeding (deploy error 10021).
