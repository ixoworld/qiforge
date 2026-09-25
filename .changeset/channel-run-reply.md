---
'@ixo/oracle-runtime-workers': patch
---

Finished `POST /channels/turn` runs return their reply. The run store read a stored `channel` client back as `portal`, so a finished channel run kept no reply text (the receipt returned an empty `text`) and its assistant message was not mirrored to the Companion room when the run ended. A `channel` run now reads back as `channel`; an unknown stored value still reads as `portal`.
