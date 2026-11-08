---
'@ixo/oracle-runtime-workers': patch
---

Hub actions: the tools that prepare an Auth Hub action (`hub_action_capabilities`, `hub_action_options`, `request_hub_action`, `describe_chain_messages` and `request_chain_transaction`) are offered on channel turns only, as request-time tools. On a Portal, Matrix or other turn they could only refuse, and a model that was offered them read the bare `{status: 'unavailable'}` as an Auth Hub outage (it told a Portal user that Auth Hub was unavailable when the Hub was never called). Those turns now get `hub_action_status` alone, whose description says Hub actions are prepared only in a channel chat (such as WhatsApp) and never to call that an outage. Every refusal now carries a reason: off a channel turn, "Auth Hub was not contacted and nothing was prepared or sent; ask in the channel chat"; with Hub actions off, "not enabled for this oracle"; a status read without a valid id names the `actionId` it needs.
