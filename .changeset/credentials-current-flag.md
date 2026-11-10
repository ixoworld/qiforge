---
'@ixo/oracle-runtime-workers': patch
---

credentials: honour the Auth Hub's per-item `current` flag and export the time wording.

- `HubPermissionsClient` parses `current: boolean` (optional) on every item of the single view and the list, and passes it through (`PermissionItemState`, `ListedPermission`, the person's cached card status). Absent (an older Hub) is unknown and read as current; `isOutdatedItem(item)` is true only for an explicit `false`.
- An allowed item marked `current: false` is never reused: it covers nothing in the request tools, its action stops being the card in use or the one waiting, its kept grants are dropped, and the person is asked again on ONE card: "I need your OK once more for this. Please tap Allow here: <link>". `credentials_request_action` sends that card by itself; `credentials_permission_status` shows the item with `current: false` and no grants; `credentials_action_status` answers `permission_outdated`.
- `relativeTime`, `whenItEnds`, `SelfTime` and `selfTimeSeconds` are exported from the package root so other plugins use the same words ("in 15 minutes", "in about 2 hours").
