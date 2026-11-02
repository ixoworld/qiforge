---
'@ixo/oracle-runtime-workers': patch
---

Yoma plugin, for the first pilots on WhatsApp: dates are asked in plain words. The question and a refused date give the model today's date, so "yesterday" or "last Friday" becomes `value` YYYY-MM-DD without the person ever being asked for a format. `skip` takes `allOptional: true` ("skip the optional ones"), kept on the draft, so every optional question still to come is passed over; required questions are still asked.
