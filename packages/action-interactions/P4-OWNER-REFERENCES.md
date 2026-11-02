# Native owner references

P4 adds `owner-reference`, a private locator for existing Matrix, Topic, Flow-detail and governed form-workbench records. The authenticated account, oracle and conversation still scope every reference. The reference service stores no native answer, record body, permission, signature or execution callback.

Prepare requires empty values. Update (including cancellation), reserve and observe are refused; dispatch does not accept this owner kind. Locator identity includes its family and exact native revision pins. A new revision produces a different reference. These checks prevent a saved locator from becoming an executable proposal.

Portal resolves the actual native owner and its current permissions, revision and state before display or review. Personal reference reads cannot establish Matrix/Topic authority or disclose a hidden record. The reference's `draft` wrapper status describes storage only; clients display the native owner's own lifecycle. Reopening never replays an answer patch or reconstructs a missing proposal.

The health owner advertisement is additive. Consumers may enable P4 references independently while retaining P3 against older runtimes. `ACTION_INTERACTIONS_ENABLED` remains off by default. This change does not activate, publish, merge or deploy a runtime.

Validation: 7 portable schema/client tests, portable strict typecheck, 19 real Workers integration tests and Workers typecheck passed. Native authorization and human signing remain consumer/protocol responsibilities.
