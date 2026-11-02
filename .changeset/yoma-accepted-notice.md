---
'@ixo/oracle-runtime-workers': patch
---

Yoma plugin: "you were accepted". At the start of a person's next message, the plugin checks their sent applications (at most every 5 minutes each, at most 3 a message) and, when the job's admin now lets them log work, the model opens with "Good news: you were accepted for …" and offers to start logging work. Each acceptance is told once (kept on the application's draft); one they already log work on is not announced. A failed chain read never fails the turn.
