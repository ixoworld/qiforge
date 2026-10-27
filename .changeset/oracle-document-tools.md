---
'@ixo/oracle-runtime-workers': minor
---

Memory plugin: `add_oracle_document`, `list_oracle_documents` and `delete_oracle_document`. An oracle can turn a chat attachment or a Library file into domain knowledge through the Memory Engine's `/knowledge/documents` routes, either grouped under one document id (a board resolution, a contract, a policy, a report) or as loose knowledge (a file of unrelated facts); the model is told to ask the person when it cannot tell and to confirm the public or private space first. New `documentTools` plugin option (default true) and `MEMORY_DOCUMENT_CHUNK_BYTES`, `MEMORY_DOCUMENT_MAX_CHUNKS`, `MEMORY_DOCUMENT_MAX_CHARS` settings; requests send `x-oracle-entity-did` (`ORACLE_ENTITY_DID`) like every other engine path. Needs a Memory Engine with the `/knowledge/documents` routes (Memory Engine 2.3.0 or later).
