---
'@ixo/oracle-runtime-workers': patch
---

Files from a chat channel (WhatsApp) are never sent to the model as raw bytes. Photos, documents and videos go through the helper model and the turn's model gets their text, whatever it can read natively; `view_attachment` returns them as text too. A native block kept the whole file as base64 in a message that is replayed on every later turn and stored in the checkpoint: a 600 KB PDF counted as about 200,000 tokens and reset the user object's 128 MB isolate on every attempt, leaving the chat stuck until `/new`. Tools still read the file itself through `ctx.session.channel.attachments`, so claim evidence is unchanged. Portal and Matrix files are routed as before.
