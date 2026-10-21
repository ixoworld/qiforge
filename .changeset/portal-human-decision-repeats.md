---
'@ixo/oracle-runtime-workers': patch
---

Portal questions and approval requests (`ask_user_question`, `propose_domain_creation`, `write_domain_files`, `publish_recipe_release`) are non-repeatable writes for the per-turn repetition guard, so an identical pending human decision is issued once per turn instead of up to five times. Navigation and read browser tools stay repeatable.
