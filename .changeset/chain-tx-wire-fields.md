---
'@ixo/oracle-runtime-workers': patch
---

`request_chain_transaction`: the model-facing schema now declares each message type's field names and basic types (derived from the catalogue, without descriptions, patterns or limits). In 0.29.0 each message declared only `type` with no other properties allowed, so a model provider dropped the other fields (`toAddress`, `amount`, …) and every call was refused as incomplete. Each per-type object stays open, so a field a type does not have still reaches the handler, which names it; formats and limits are still checked by the handler against the full catalogue schema. Per-request cost of the two chain tools is about 3.4 KB.
