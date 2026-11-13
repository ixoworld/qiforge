---
'@ixo/oracle-runtime-workers': patch
---

A tapped WhatsApp button is read as the option the person chose again. The
turn marks the person's message with the tapped-choice note
(`channel_choice_note`), but saving the turn's first checkpoint dropped it:
the message serializer keeps only an allowlist of `additional_kwargs` and
writes the result back onto the live message, so every tool afterwards saw
the note and the title as one text and rejected the answer. The note is now
on the allowlist (broken since 0.50.0, when button taps arrived).

`userContent` also takes the notes off in the reverse of the order the turn
adds them: a tap that quotes the message it was on carries the quoted-reply
note outside the choice note, and the choice note stayed in the person's
words.

Two other markers the runtime sets and reads after a checkpoint were dropped
the same way and are kept now: `forwardedFrom` on a sub-agent's forwarded
calls (since 0.41.3 the parent model saw them again from the next step on)
and `capped` on a capped tool result (a pruned result pointed `read_result`
at the tool call id instead of the saved result).
