---
'@ixo/oracle-runtime-workers': patch
---

A call a sub-agent forwards into the chat (an AG-UI chart from `call_ag-ui_agent`) streams under the id the chat stores it with, `<parent call id>_<call id>`, instead of an internal run id. A client now keeps one card per call while the reply streams and after it refetches the chat.
