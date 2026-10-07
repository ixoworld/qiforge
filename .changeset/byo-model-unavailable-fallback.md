---
'@ixo/oracle-runtime-workers': patch
---

A BYO model the user's provider refuses (the ChatGPT backend's immediate empty `400` for a model the subscription does not serve, an API provider's `404 model_not_found`) no longer fails the turn with a generic error: before any output, the call is answered by the platform model behind a `byo_fallback` notice with the new reason `model_unavailable` ("Your ChatGPT subscription doesn't offer <model>, so this reply used the platform model instead. …"), and the rest of the turn uses the platform model for that model id. `createByoLlmAdapter` now hands out `ByoModelFallbackChatModel` wrappers; `isModelUnavailableError` is exported.
