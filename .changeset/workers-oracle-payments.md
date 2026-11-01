---
'@ixo/oracle-runtime-workers': minor
---

Paid services on the Workers runtime. The new opt-in `OraclePaymentsPlugin`
sells the services in `AGENT_CARD_JSON` over chat and gets the oracle paid on
chain. A free front desk (support mode: only the plugin's and memory's tools)
quotes and runs `start_work`. That checks the contract (the oracle's AuthZ grant,
the buyer's deed and their decision-engine agreement) and reserves the agreed
price as a claim intent. Work mode then has the full tool surface plus
`deliver_work`, which files the escrow-backed work claim, and `cancel_work`.

Two runtime additions any plugin can use: `ctx.chain`, the oracle's own chain
account (`ORACLE_SECP_MNEMONIC` plus a `SEQUENCE_MANAGER` binding to the
re-exported `SequenceManagerDO`), and the `getTurnScope` plugin hook, which
narrows one turn's tools and adds a prompt overlay.
