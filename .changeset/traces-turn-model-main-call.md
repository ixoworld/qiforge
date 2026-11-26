---
'@ixo/oracle-runtime-workers': patch
---

IXO Traces: the turn's model (`served_model` in the turn metadata) now comes from the main agent's own model calls only (purpose `reply`, not inside a sub-agent), never from a routing, attachment, plugin, summary, safety or sub-agent call. Before, a turn whose reply call failed before the provider named a model got the capability router's model, because the router's call was the only one that reported one. Now the turn carries the model that served the latest reply call that reported one; when none did (the reply call failed first), the model the latest reply call asked for (its call record, else the run's invocation params or `ls_model_name`); with no reply call at all, no `served_model`. The contract has no turn-level "requested" key, so a requested model is sent as `served_model`; the failed LLM run itself still shows `ls_model_name` without `served_model`.
