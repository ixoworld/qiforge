---
'@ixo/oracle-runtime-workers': minor
---

New opt-in `YomaPlugin` (`@ixo/oracle-runtime-workers/plugins/yoma`): Yoma's programmes and jobs as jambo.yoma.world shows them, applying and logging work through each job's own SurveyJS form one question at a time, and whether logged work was approved and paid. Two tools, `yoma_lookup` (1–6 batched requests) and `yoma_form` (one action per call), `on-demand` by default. Reads go through ixo-chain's bounded HTTP policy and never throw. Applications go out as the Auth Hub's `ixo.bid.submit.v1` card when the Hub offers it to the account (`@ixo/action-protocol` 0.6.0, Hub protocol level 4); logged work stays saved until claims can be sent. Not in `BUNDLED_WORKERS_PLUGINS`, so `survey-core` only lands in oracles that import it. ixo-chain's HTTP helpers take a log tag and two more sources (`job-list`, `document`).
