---
'@ixo/oracle-runtime-workers': patch
---

Reverts #449 (chat-channel files sent to the model as text instead of raw bytes), which went out in 0.36.0 before review. Channel attachments behave as in 0.35.1 again. The change is reopened as its own PR for review.
