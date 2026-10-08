---
'@ixo/oracle-runtime-workers': minor
---

`POST /channels/turn` refusals now carry a machine-readable `code` next to `message` (`{ code, message }`); `delegation_required` and `room_not_ready` answer `428` instead of `409`.
A channel turn's delegation is checked before the user object boots: it must exist and have more than 900 s left, and a boot failing with `NO_VFS_DELEGATION` also answers `428 delegation_required` instead of a retried `503`.
Any other failure still answers `503`, now with `code: 'unavailable'`, and is logged as `[channels] turn failed unexpectedly: <name>: <message>`.
