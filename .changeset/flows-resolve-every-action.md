---
'@ixo/oracle-runtime-workers': patch
---

The Flow Builder resolves every action `list_actions` offers. `@ixo/editor`'s type-to-ability table leaves out 13 of its own registry's actions (`qi/form.submit`, the oracle deploy steps, the carbon and collection actions and others), so `validate_flow` and `create_template` refused them as unknown; the action's registry definition now answers when the table does not, in both directions.
