---
'@ixo/oracle-runtime-workers': patch
---

Image blocks count a flat 3,300 tokens in every request-size estimate instead of their base64 at chars/4. One resized phone photo looked like ~128k tokens, so on a model with a smaller window the context guard could refuse a turn with a photo. Native document blocks still count by size.
