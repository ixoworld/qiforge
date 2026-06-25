/**
 * Plugin-side action-metadata overlay (spec §5, §7.5). A map keyed by action
 * `type` that enriches the editor registry with agent-facing descriptions,
 * tags, typed input ports, and prerequisites — merged with `getAllActions()` at
 * runtime (see actions.ts / linkage.ts / references.ts), never editing
 * `ActionDefinition`.
 *
 * What lives here vs. what lives in the editor registry:
 *   - OUTPUTS come from the registry `outputSchema` — never duplicated here.
 *   - INPUT requirements: most actions now ship a machine-readable `inputSchema`
 *     (which actions.ts prefers). The `inputPorts` below add agent-facing prose
 *     and semantic port types (port-types.ts) that drive linkage compatibility,
 *     and remain the authoritative input list for any action shipping no schema.
 *   - `summary` / `whenToUse` / `whenNotToUse` / `tags` / `requires` exist ONLY
 *     here — they are the agent-discovery surface (`list_actions` /
 *     `describe_action`) and are not derivable from the registry.
 *
 * `requires` captures human/environment prerequisites the user must supply (a
 * claim collection, a template id, a connected account, a PIN) — the things the
 * agent must STOP and ASK the user for rather than invent. The multi-operation
 * actions (`qi/collection.lifecycle`, `qi/collection.users`) dispatch on an
 * `operation` input; their `inputPorts` note which fields apply to which op.
 *
 * Keep entries in sync with each action's `run()` requirements in the editor.
 */
export interface ActionPort {
  /** The input field name, exactly as the action's `run()` reads it. */
  path: string;
  /** Semantic port type (port-types.ts) — drives linkage compatibility. */
  portType: string;
  /** True when the action's `run()` throws if this field is missing. */
  required?: boolean;
  /** One-line, agent-facing description of what to put here. */
  description?: string;
}

export interface ActionRequirement {
  kind: string;
  description: string;
}

export interface OverlayEntry {
  summary?: string;
  whenToUse?: string[];
  whenNotToUse?: string[];
  tags?: string[];
  inputPorts?: ActionPort[];
  outputPorts?: ActionPort[];
  requires?: ActionRequirement[];
}

/**
 * Keyed by action `type` (e.g. "qi/email.send"). Input field names + `required`
 * flags are transcribed from the editor action `run()` checks. Output ports are
 * NOT listed here — they come from the registry's `outputSchema` (actions.ts
 * outputFields). Covers every registered action type.
 */
export const ACTION_METADATA: Record<string, OverlayEntry> = {
  // ── Claims & bids ─────────────────────────────────────────────────────────
  'qi/claim.submit': {
    summary:
      'Submit a claim (an application/report/form submission) into a claim collection on a deed/entity, broadcasting an on-chain submission transaction. May prompt the submitter for a verification PIN at runtime.',
    whenToUse: [
      'An automation needs to record a claim — an application, a report, a form submission — into an existing claim collection.',
    ],
    tags: ['claims'],
    inputPorts: [
      {
        path: 'deedDid',
        portType: 'entityDid',
        required: true,
        description: 'The entity/deed DID that owns the claim collection.',
      },
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description: 'The claim collection to submit into.',
      },
      {
        path: 'adminAddress',
        portType: 'chainAddress',
        required: true,
        description: "The claim collection admin's chain address.",
      },
      {
        path: 'surveyAnswers',
        portType: 'object',
        required: true,
        description:
          "The claim's answer data (the submitted form, as an object or a JSON string). Wire from an upstream survey/form block's output.",
      },
      {
        path: 'pin',
        portType: 'string',
        required: false,
        description:
          'Verification PIN; if omitted the action requests it from the user at runtime.',
      },
    ],
    requires: [
      {
        kind: 'claimCollection',
        description:
          'A claim collection (its deed DID, collection id, and admin address) to submit into — ask the user; never invent these.',
      },
    ],
  },
  'qi/claim.evaluate': {
    summary:
      'Approve or reject a submitted claim, broadcasting an on-chain evaluation transaction (optionally paying out a coin on approval and signing a verification UDID proof). Guards that the actor holds the evaluator (EA) role for the collection before proceeding.',
    whenToUse: [
      'An automation needs to approve or reject a previously submitted claim and record the outcome on-chain.',
      'A claim-approval flow needs to pay out a coin amount when approving.',
    ],
    whenNotToUse: [
      'Do not use to record a new claim — use qi/claim.submit for that. This action only evaluates an existing claim by its claimId.',
    ],
    tags: ['claims'],
    inputPorts: [
      {
        path: 'decision',
        portType: 'string',
        required: true,
        description: 'Either "approve" or "reject"; any other value throws.',
      },
      {
        path: 'claimId',
        portType: 'claimId',
        required: true,
        description:
          'The claim being evaluated. Wire from the claim.submit block output (output.claimId).',
      },
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description: 'The claim collection the claim belongs to.',
      },
      {
        path: 'deedDid',
        portType: 'entityDid',
        required: true,
        description: 'The deed/entity DID owning the collection.',
      },
      {
        path: 'adminAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'Entity admin account address used for the on-chain evaluation.',
      },
      {
        path: 'amount',
        portType: 'object',
        required: false,
        description:
          'Payout coin ({ denom, amount }) credited on approval; accepts a JSON string, object, or array (first coin used).',
      },
      {
        path: 'createUdid',
        portType: 'boolean',
        required: false,
        description:
          'When true (and no verificationProof set), generates and signs a verification UDID proof; prompts for a PIN to sign.',
      },
      {
        path: 'verificationProof',
        portType: 'string',
        required: false,
        description:
          'Pre-existing verification proof URL; supplying it skips UDID creation.',
      },
      {
        path: 'granteeAddress',
        portType: 'chainAddress',
        required: false,
        description:
          'Evaluator address; resolves to the current user when omitted.',
      },
      {
        path: 'capabilityCid',
        portType: 'string',
        required: false,
        description:
          'Capability CID used when creating the UDID; defaults to deedDid.',
      },
      {
        path: 'rubricAuthority',
        portType: 'string',
        required: false,
        description:
          'Rubric authority used when creating the UDID; defaults to deedDid.',
      },
      {
        path: 'rubricId',
        portType: 'string',
        required: false,
        description:
          'Rubric identifier used when creating the UDID; defaults to deedDid.',
      },
      {
        path: 'traceCid',
        portType: 'string',
        required: false,
        description: 'Trace CID passed through to the UDID.',
      },
      {
        path: 'items',
        portType: 'array',
        required: false,
        description: 'Evaluation items passed through to the UDID.',
      },
      {
        path: 'patch',
        portType: 'object',
        required: false,
        description: 'Patch object passed through to the UDID.',
      },
      {
        path: 'xeroInvoiceBlockId',
        portType: 'string',
        required: false,
        description:
          'Bound Xero invoice block id; on approval, queues invoice work for that block.',
      },
      {
        path: 'xeroPaymentBlockId',
        portType: 'string',
        required: false,
        description:
          'Bound Xero payment block id used when resolving Xero bindings.',
      },
      {
        path: 'claimSnapshot',
        portType: 'object',
        required: false,
        description: 'Claim snapshot used to build the Xero invoice scope.',
      },
    ],
    requires: [
      {
        kind: 'claimCollection',
        description:
          'The deed DID, collection id, and admin address of the claim collection being evaluated — ask the user; never invent these.',
      },
      {
        kind: 'evaluatorRole',
        description:
          'The acting user must hold the evaluator (EA) role for this collection; the action refuses otherwise. Confirm the actor is an authorized evaluator.',
      },
    ],
  },
  'qi/bid.submit': {
    summary:
      'Submit a bid (an agent application) against a claim collection for a service_agent or evaluation_agent role, broadcasting an on-chain bid submission.',
    whenToUse: [
      'An automation needs an agent to apply/bid for a service-agent or evaluation-agent role on a collection.',
    ],
    whenNotToUse: [
      'Do not use to approve or reject a bid — use qi/bid.evaluate for that.',
    ],
    tags: ['bids'],
    inputPorts: [
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description: 'The claim collection the bid is submitted against.',
      },
      {
        path: 'role',
        portType: 'string',
        required: true,
        description:
          'Bid role: "service_agent" (sa) or "evaluation_agent" (ea); any other value throws.',
      },
      {
        path: 'surveyAnswers',
        portType: 'object',
        required: true,
        description:
          'Survey answers (object or JSON string) attached to the bid. Wire from an upstream survey/form block.',
      },
      {
        path: 'deedDid',
        portType: 'entityDid',
        required: false,
        description: 'Optional deed/entity DID associated with the bid.',
      },
    ],
    requires: [
      {
        kind: 'claimCollection',
        description:
          'The collection id (and optionally deed DID) to bid against — ask the user; never invent these.',
      },
    ],
  },
  'qi/bid.evaluate': {
    summary:
      'Approve or reject a submitted bid, broadcasting on-chain transactions. On approval it grants the applicant the service_agent or evaluation_agent role (with quota) and approves the bid; on rejection it records a reason.',
    whenToUse: [
      'An automation needs to approve a bidding agent (granting them a service- or evaluation-agent role) or reject their bid.',
    ],
    whenNotToUse: [
      'Do not use to submit a new bid — use qi/bid.submit for that. This action only evaluates an existing bid by its bidId.',
    ],
    tags: ['bids'],
    inputPorts: [
      {
        path: 'decision',
        portType: 'string',
        required: true,
        description: 'Either "approve" or "reject"; any other value throws.',
      },
      {
        path: 'bidId',
        portType: 'bidId',
        required: true,
        description:
          'The bid being evaluated. Wire from the bid.submit block output (output.bidId).',
      },
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description: 'The claim collection the bid belongs to.',
      },
      {
        path: 'deedDid',
        portType: 'entityDid',
        required: true,
        description: 'The deed/entity DID owning the collection.',
      },
      {
        path: 'role',
        portType: 'string',
        required: true,
        description:
          'Applicant role: "service_agent" (sa) or "evaluation_agent" (ea); determines which grant is issued on approval.',
      },
      {
        path: 'applicantDid',
        portType: 'did',
        required: true,
        description: "The bidding applicant's DID.",
      },
      {
        path: 'applicantAddress',
        portType: 'chainAddress',
        required: true,
        description: "The bidding applicant's wallet address.",
      },
      {
        path: 'adminAddress',
        portType: 'chainAddress',
        required: false,
        description:
          'Entity admin account address; required (throws if missing) when decision is "approve".',
      },
      {
        path: 'maxAmounts',
        portType: 'string',
        required: false,
        description:
          'JSON-encoded per-claim max amounts used when approving an evaluation_agent.',
      },
      {
        path: 'reason',
        portType: 'string',
        required: false,
        description:
          'Rejection reason; required (throws if missing) when decision is "reject".',
      },
    ],
    requires: [
      {
        kind: 'claimCollection',
        description:
          'The deed DID, collection id, and (for approvals) admin address of the collection — ask the user; never invent these.',
      },
      {
        kind: 'evaluatorAuthority',
        description:
          'The actor must be authorized to evaluate bids and grant roles for this collection. Confirm the actor has admin/approver authority.',
      },
    ],
  },

  // ── Claim collections (multi-operation dispatchers) ───────────────────────
  'qi/collection.lifecycle': {
    summary:
      'Manage a claim collection lifecycle on a deed/entity. A single action that dispatches on `operation`: `create` mints a new collection (MsgCreateCollection) and emits a `created` event; `updateState`/`updateDates`/`updateQuota`/`updatePayments`/`updateIntents` mutate an existing one (the matching MsgUpdateCollection* tx); `refresh` is a read-only re-fetch. Every write returns the full latest on-chain CollectionState (incl. the chain-assigned collectionId); the admin address is resolved from chain, not passed in.',
    whenToUse: [
      'Stand up a brand-new claim collection on an entity/deed (operation: create) before any claims or grants exist.',
      'Pause/reopen/close, reschedule, recap quota, or reconfigure payments/intents of an existing collection (operation: update*).',
      'Read back the current on-chain state of a collection without mutating it (operation: refresh).',
    ],
    whenNotToUse: [
      'Granting/revoking who can submit or evaluate on the collection — use qi/collection.users.',
      'Submitting or evaluating an actual claim — use qi/claim.submit / qi/claim.evaluate.',
    ],
    tags: ['collections'],
    inputPorts: [
      {
        path: 'operation',
        portType: 'string',
        required: true,
        description:
          'Which op to run: create | updateState | updateDates | updateQuota | updatePayments | updateIntents | refresh.',
      },
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description:
          'Target collection — required for every op EXCEPT create (which mints a new one).',
      },
      {
        path: 'entity',
        portType: 'entityDid',
        description:
          'create only (required): entity/deed DID the new collection belongs to.',
      },
      {
        path: 'protocol',
        portType: 'did',
        description:
          "create only (required): claim protocol DID the collection follows — a bare did: (no '#' fragment) resolved from the entity's linked claims.",
      },
      {
        path: 'state',
        portType: 'number',
        description:
          'create / updateState (required for updateState): lifecycle state 0=OPEN, 1=PAUSED, 2=CLOSED.',
      },
      {
        path: 'startDate',
        portType: 'string',
        description:
          'create / updateDates: ISO-8601 start date (updateDates needs at least one of startDate/endDate).',
      },
      {
        path: 'endDate',
        portType: 'string',
        description: 'create / updateDates: ISO-8601 end date.',
      },
      {
        path: 'quota',
        portType: 'string',
        description:
          "create / updateQuota (required for updateQuota): max claims, '0' = unlimited; must be 0 or >= the current submitted count.",
      },
      {
        path: 'payments',
        portType: 'object',
        description:
          'create / updatePayments (required for updatePayments): submission/evaluation/approval/rejection payment legs.',
      },
      {
        path: 'intents',
        portType: 'object',
        description:
          'create / updateIntents (required for updateIntents): intent configuration.',
      },
    ],
    requires: [
      {
        kind: 'entity',
        description:
          'For create: the owning entity/deed DID and a ledgered claim protocol DID picked from the entity — ask the user; never invent these.',
      },
      {
        kind: 'claimCollection',
        description:
          'For every non-create op: an existing collection id whose admin authorises the change — ask the user; never invent it.',
      },
    ],
  },
  'qi/collection.users': {
    summary:
      "Manage who can submit or evaluate claims on one collection. A single action that dispatches on `operation`: `add` grants submit/evaluate authz to a grantee (fanning out one grant per member when granteeKind is group-members); `revoke` does a read-modify-write that drops just the target collection's constraint while preserving the grantee's other grants; `list` is a read-only query of current grantees. Writes broadcast the claims-module authz tx and return its transactionHash.",
    whenToUse: [
      'Authorize an agent/user (or every member of a group) to submit or evaluate claims for a collection (operation: add).',
      "Remove one grantee's submit/evaluate authorization for a collection (operation: revoke).",
      'Enumerate who currently holds submit/evaluate authz on a collection (operation: list).',
    ],
    whenNotToUse: [
      'Creating or mutating the collection itself — use qi/collection.lifecycle.',
    ],
    tags: ['collections', 'grants'],
    inputPorts: [
      {
        path: 'operation',
        portType: 'string',
        required: true,
        description: 'Which op to run: add | revoke | list.',
      },
      {
        path: 'collectionId',
        portType: 'claimCollectionId',
        required: true,
        description: 'Target claim collection.',
      },
      {
        path: 'adminAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'Granter entity admin account address (the authz granter) whose grants are written/queried.',
      },
      {
        path: 'role',
        portType: 'string',
        description:
          "add/revoke (required): authorization to grant or revoke — 'submit' or 'evaluate'.",
      },
      {
        path: 'granteeAddress',
        portType: 'chainAddress',
        description:
          "add/revoke: grantee bech32 address (required for revoke, and for add unless granteeKind is 'group-members').",
      },
      {
        path: 'granteeKind',
        portType: 'string',
        description:
          "add: how to treat the grantee — 'user', 'group-account', or 'group-members' (fan out per member). Defaults to 'user'.",
      },
      {
        path: 'members',
        portType: 'array',
        description:
          "add: resolved members to fan the grant out to — required and non-empty when granteeKind is 'group-members'.",
      },
      {
        path: 'agentQuota',
        portType: 'string',
        description: "add: remaining agent quota; '0' = unlimited.",
      },
      {
        path: 'maxAmount',
        portType: 'array',
        description: 'add: per-claim max amount cap (evaluate role).',
      },
      {
        path: 'intentDurationNs',
        portType: 'string',
        description: 'add: intent duration in nanoseconds, as a string.',
      },
      {
        path: 'deedDid',
        portType: 'entityDid',
        description: 'Entity (deed) DID forwarded to the handler.',
      },
    ],
    requires: [
      {
        kind: 'claimCollection',
        description:
          'The target collection id and its granter entity admin account address — ask the user; never invent them.',
      },
      {
        kind: 'grantee',
        description:
          "For add/revoke: the grantee's bech32 address (or the group/members to fan out to) and the role (submit/evaluate) — ask the user.",
      },
    ],
  },

  // ── Notifications & integrations ──────────────────────────────────────────
  'qi/email.send': {
    summary:
      'Sends a templated email via the configured email service; side-effect, delivers a real message to the recipient.',
    whenToUse: [
      'An automation needs to email someone — a confirmation, notice, or alert.',
      'You have a pre-registered email template and a recipient address to send it to.',
    ],
    tags: ['notify', 'email'],
    inputPorts: [
      {
        path: 'to',
        portType: 'emailAddress',
        required: true,
        description:
          'Recipient email address. run() throws "Recipient (to) is required" if missing.',
      },
      {
        path: 'templateName',
        portType: 'string',
        required: true,
        description:
          'The pre-registered email template id to send. Either templateName or its alias `template` satisfies the requirement; run() throws "No template selected" if neither is provided. Ask the user which template.',
      },
      {
        path: 'template',
        portType: 'string',
        description:
          'Alias for templateName — the template id. Provide this OR templateName.',
      },
      {
        path: 'subject',
        portType: 'string',
        description: 'Email subject line.',
      },
      {
        path: 'templateVersion',
        portType: 'string',
        description: 'Optional specific version of the template to render.',
      },
      {
        path: 'variables',
        portType: 'object',
        description:
          'Template variables to interpolate; accepts an object or a JSON string (invalid JSON falls back to {}).',
      },
      {
        path: 'cc',
        portType: 'emailAddress',
        description: 'Carbon-copy recipient address.',
      },
      {
        path: 'bcc',
        portType: 'emailAddress',
        description: 'Blind-carbon-copy recipient address.',
      },
      {
        path: 'replyTo',
        portType: 'emailAddress',
        description: 'Reply-to address for the email.',
      },
    ],
    requires: [
      {
        kind: 'emailTemplate',
        description:
          'A pre-registered email template id — ask the user; never invent one.',
      },
    ],
  },
  'qi/matrix.dm': {
    summary:
      'Direct-messages a user by their DID over Matrix — converts the target DID to a Matrix user id, finds or creates a DM room (tracked via m.direct account data), and sends the text. Side-effect: delivers a real Matrix message.',
    whenToUse: [
      'You need to ping a specific person/agent identified by their DID with a chat message.',
      'An in-flow notification should go to a Matrix user rather than email.',
    ],
    whenNotToUse: [
      'Do NOT target a DID that resolves to the sender\'s own Matrix user id — a self-DM makes createRoom fail with 403 "already in the room". The recipient must be someone other than the signed-in sender.',
    ],
    tags: ['notify', 'matrix'],
    inputPorts: [
      {
        path: 'targetDid',
        portType: 'did',
        required: true,
        description:
          'Recipient DID; converted to @did-...:<homeserver>. Wire from an upstream block that produces the recipient DID. run() throws "Recipient DID is required" if blank.',
      },
      {
        path: 'message',
        portType: 'string',
        required: true,
        description:
          'The message text to send. run() throws "Message is required" if blank.',
      },
    ],
    requires: [
      {
        kind: 'recipientDid',
        description:
          "A recipient DID distinct from the sender — ask the user; never use the sender's own DID.",
      },
    ],
  },
  'qi/notification.push': {
    summary:
      'Sends a notification through the configured notify service across a chosen delivery channel; side-effect, dispatches to one or more recipients.',
    whenToUse: [
      'An automation needs to alert one or more recipients over a configurable channel (e.g. push/email/sms).',
      'You want CC/BCC and an HTML or text body in a single notification.',
    ],
    whenNotToUse: [
      'For a Matrix direct message to a DID use qi/matrix.dm; for a strictly templated email use qi/email.send — this block is the generic multi-channel notifier.',
    ],
    tags: ['notify'],
    inputPorts: [
      {
        path: 'to',
        portType: 'array',
        required: true,
        description:
          'Recipient(s); a single value or array — at least one required. run() throws "At least one recipient is required" if empty.',
      },
      {
        path: 'channel',
        portType: 'string',
        description: 'Delivery channel for the notification (service-defined).',
      },
      { path: 'cc', portType: 'array', description: 'CC recipients.' },
      { path: 'bcc', portType: 'array', description: 'BCC recipients.' },
      {
        path: 'subject',
        portType: 'string',
        description: 'Notification subject.',
      },
      {
        path: 'body',
        portType: 'string',
        description: 'Notification body content.',
      },
      {
        path: 'bodyType',
        portType: 'string',
        description: "Body format: 'text' or 'html'.",
      },
      { path: 'from', portType: 'string', description: 'Sender address.' },
      { path: 'replyTo', portType: 'string', description: 'Reply-to address.' },
    ],
    requires: [
      {
        kind: 'recipient',
        description:
          'At least one recipient — ask the user who should be notified.',
      },
    ],
  },
  'qi/http.request': {
    summary:
      'Performs an HTTP request to an external endpoint (via the configured http service, falling back to native fetch) and returns status plus parsed JSON data. No on-chain side-effect, but it does call out to a third-party URL.',
    whenToUse: [
      'A flow needs to call an external API or webhook.',
      'You want to fetch or POST data to an off-chain service and use its response downstream (read {{block.output.data}} / {{block.response.*}}).',
    ],
    tags: ['integration', 'http'],
    inputPorts: [
      {
        path: 'endpoint',
        portType: 'string',
        required: true,
        description:
          'The request URL. Either endpoint or its alias `url` must be provided; run() throws "HTTP request action requires an endpoint or url input" if neither resolves to a non-empty string.',
      },
      {
        path: 'url',
        portType: 'string',
        description:
          'Alias for endpoint — the request URL. Provide this OR endpoint.',
      },
      {
        path: 'method',
        portType: 'string',
        description: 'HTTP method (GET, POST, etc.). Defaults to GET.',
      },
      {
        path: 'headers',
        portType: 'object',
        description: 'Request headers as a key/value map.',
      },
      {
        path: 'body',
        portType: 'string',
        description:
          'Request body; only sent for non-GET methods. Accepts a string or an object (serialized to JSON).',
      },
    ],
    requires: [
      {
        kind: 'endpoint',
        description:
          'The target endpoint URL (and any auth headers/credentials it needs) — ask the user; never invent an endpoint.',
      },
    ],
  },
  'qi/credential.store': {
    summary:
      'Stores a verifiable credential in Matrix via the matrix credential-storage service, keyed by credentialKey and deduplicated by a computed IPFS-compatible CID. Side-effect: persists the credential to a Matrix room.',
    whenToUse: [
      'A flow has produced or collected a credential (e.g. a KYC/AML attestation) that must be persisted.',
      'You need an idempotent store keyed by content (re-storing the same credential returns duplicate:true).',
    ],
    tags: ['credentials'],
    inputPorts: [
      {
        path: 'credentialKey',
        portType: 'string',
        required: true,
        description:
          'Key under which to store the credential (e.g. "kycamllevel1"). run() throws "credentialKey is required" if missing.',
      },
      {
        path: 'credential',
        portType: 'object',
        required: true,
        description:
          'The credential to store — a JSON object (also accepts a JSON string, unwrapped up to 3 layers). Must resolve to a plain object, not an array. Wire from the upstream block that issues/collects the credential.',
      },
      {
        path: 'roomId',
        portType: 'roomId',
        description:
          'Matrix room ID to store the credential in; defaults to empty if omitted.',
      },
    ],
    requires: [
      {
        kind: 'credentialKey',
        description:
          'The key (credential type id, e.g. kycamllevel1) under which to store — ask the user; never invent one.',
      },
    ],
  },

  // ── Wallet & identity ─────────────────────────────────────────────────────
  'qi/wallet.generate': {
    summary:
      'Generate a fresh IXO secp256k1 key pair off-chain — no blockchain transaction. Returns the wallet address, derived DID, public key, and BIP39 mnemonic.',
    whenToUse: [
      'Bootstrap a new oracle/agent identity at the start of a flow so downstream steps can fund it, create its IID document, or register a Matrix account.',
      'You need a DID + mnemonic + pubKey to feed into iid.create, matrix.register, or identity.create.',
    ],
    whenNotToUse: [
      'You also need the new wallet funded on-chain in one step — use wallet.generateAndFund instead (this action performs no funding transaction).',
    ],
    tags: ['wallet'],
    inputPorts: [],
  },
  'qi/wallet.fund': {
    summary:
      'Fund an existing IXO wallet address with an on-chain funding transaction (defaults to 250000 base units). Side-effecting and confirmation-gated by default; returns the transaction hash.',
    whenToUse: [
      'Top up a wallet address that already exists so it can pay for subsequent on-chain operations.',
      'Fund a wallet produced by an upstream wallet.generate step before it creates an IID document.',
    ],
    whenNotToUse: [
      'The wallet does not exist yet — use wallet.generate first, or wallet.generateAndFund to do both in one step.',
    ],
    tags: ['wallet'],
    inputPorts: [
      {
        path: 'address',
        portType: 'chainAddress',
        required: true,
        description:
          'IXO wallet address to fund. Typically wired from an upstream wallet.generate step output (address).',
      },
      {
        path: 'amount',
        portType: 'number',
        description:
          'Funding amount in base units. Defaults to 250000 if omitted.',
      },
    ],
    requires: [
      {
        kind: 'fundingAmount',
        description:
          'Confirm the funding amount in base units (defaults to 250000 if not specified).',
      },
    ],
  },
  'qi/wallet.generateAndFund': {
    summary:
      'One-shot: generate a fresh IXO key pair off-chain, then fund the new wallet address on-chain (defaults to 250000 base units). Returns address, DID, public key, mnemonic, and the funding transaction hash.',
    whenToUse: [
      'Bootstrap a ready-to-use, funded oracle/agent wallet in a single step at the start of a flow.',
      'You need both a new DID/mnemonic AND on-chain funds before creating IID documents or registering Matrix accounts.',
    ],
    whenNotToUse: [
      'You only need keys with no on-chain funding — use wallet.generate (this performs a funding transaction).',
      'The wallet already exists and only needs topping up — use wallet.fund.',
    ],
    tags: ['wallet'],
    inputPorts: [
      {
        path: 'amount',
        portType: 'number',
        description:
          'Funding amount in base units for the generated wallet. Defaults to 250000 if omitted.',
      },
    ],
    requires: [
      {
        kind: 'fundingAmount',
        description:
          'Confirm the funding amount in base units (defaults to 250000 if not specified).',
      },
    ],
  },
  'qi/iid.create': {
    summary:
      'Create an on-chain IID (decentralized identity) document for a wallet, broadcasting a blockchain transaction. Returns the IID document DID and the creation transaction hash.',
    whenToUse: [
      'Register an on-chain IID document for a wallet produced by an upstream wallet step.',
      'You need a DID anchored on-chain before it can be used as an oracle/agent identity.',
    ],
    whenNotToUse: [
      'You also need a Matrix account registered for the identity — use identity.create, which creates the IID document AND registers Matrix in one step.',
    ],
    tags: ['identity', 'iid'],
    inputPorts: [
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Wallet mnemonic used to sign the IID creation. Typically wired from an upstream wallet step output (mnemonic).',
      },
      {
        path: 'did',
        portType: 'did',
        required: true,
        description:
          'DID for the IID document. Typically wired from an upstream wallet step output (did).',
      },
      {
        path: 'address',
        portType: 'chainAddress',
        required: true,
        description:
          'Blockchain address for the IID document. Typically wired from an upstream wallet step output (address).',
      },
      {
        path: 'pubKey',
        portType: 'string',
        required: true,
        description:
          'secp256k1 public key for the IID document. Typically wired from an upstream wallet step output (pubKey).',
      },
    ],
  },
  'qi/identity.create': {
    summary:
      'Full identity bootstrap: create an on-chain IID document AND register a Matrix account in two phases. Returns the DID, IID transaction hash, alreadyExisted flag, and the full Matrix account credentials (user ID, access token, room ID, device ID, mnemonic, password, recovery phrase, homeserver URL).',
    whenToUse: [
      'Stand up a complete oracle/agent identity (on-chain IID + Matrix messaging account) from a single funded wallet.',
      'You need both an on-chain DID and Matrix credentials downstream.',
    ],
    whenNotToUse: [
      'You only need the on-chain IID document with no Matrix account — use iid.create.',
      'You only need a Matrix account for an identity that already has its IID document — use matrix.register.',
    ],
    tags: ['identity', 'matrix', 'iid'],
    inputPorts: [
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Wallet mnemonic used to create the IID document and Matrix account. Typically wired from an upstream wallet step output (mnemonic).',
      },
      {
        path: 'did',
        portType: 'did',
        required: true,
        description:
          'DID for the IID document. Typically wired from an upstream wallet step output (did).',
      },
      {
        path: 'address',
        portType: 'chainAddress',
        required: true,
        description:
          'Blockchain address. Typically wired from an upstream wallet step output (address).',
      },
      {
        path: 'pubKey',
        portType: 'string',
        required: true,
        description:
          'secp256k1 public key. Typically wired from an upstream wallet step output (pubKey).',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description: 'PIN used to register the Matrix account.',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Oracle name for the Matrix account.',
      },
      {
        path: 'avatarUrl',
        portType: 'string',
        description:
          'Avatar URL for the Matrix account (mapped from form logoUrl).',
      },
      {
        path: 'formAnswers',
        portType: 'string',
        description:
          'JSON string of runtime form answers merged into inputs; explicit template inputs take precedence.',
      },
    ],
    requires: [
      {
        kind: 'pin',
        description: 'A PIN is required to register the Matrix account.',
      },
      {
        kind: 'oracleName',
        description: 'An oracle name is required for the Matrix account.',
      },
    ],
  },
  'qi/matrix.register': {
    summary:
      'Register a Matrix messaging account for an existing wallet/DID. Returns the Matrix user ID, access token, room ID, device ID, mnemonic, password, recovery phrase, and homeserver URL.',
    whenToUse: [
      'Give an existing identity a Matrix account for encrypted collaboration/messaging.',
      'Add Matrix credentials to a wallet/DID that already has its on-chain IID document.',
    ],
    whenNotToUse: [
      'The identity has no on-chain IID document yet and you want both at once — use identity.create, which creates the IID document and registers Matrix together.',
    ],
    tags: ['matrix'],
    inputPorts: [
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Wallet mnemonic used to register the Matrix account. Typically wired from an upstream wallet step output (mnemonic).',
      },
      {
        path: 'address',
        portType: 'chainAddress',
        required: true,
        description:
          'Blockchain address. Typically wired from an upstream wallet step output (address).',
      },
      {
        path: 'did',
        portType: 'did',
        required: true,
        description:
          'DID associated with the Matrix account. Typically wired from an upstream wallet step output (did).',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description: 'PIN used to register the Matrix account.',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Oracle name for the Matrix account.',
      },
      {
        path: 'avatarUrl',
        portType: 'string',
        description: 'Avatar URL for the Matrix account.',
      },
    ],
    requires: [
      {
        kind: 'pin',
        description: 'A PIN is required to register the Matrix account.',
      },
      {
        kind: 'oracleName',
        description: 'An oracle name is required for the Matrix account.',
      },
    ],
  },

  // ── Oracle setup & deploy ─────────────────────────────────────────────────
  'qi/entity.createOracle': {
    summary:
      'Creates the oracle on-chain entity (broadcasts the entity-creation tx) and registers a P-256 keyAgreement encryption key on the oracle entity DID. On-chain side effect.',
    whenToUse: [
      'As the on-chain entity step of the oracle-creation flow, after the oracle wallet, IID, and Matrix account exist.',
    ],
    tags: ['oracle', 'entity', 'onchain'],
    inputPorts: [
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Oracle wallet BIP39 mnemonic, typically from the wallet.generate output.',
      },
      {
        path: 'address',
        portType: 'chainAddress',
        required: true,
        description:
          'Oracle wallet address, typically from the wallet.generate output.',
      },
      {
        path: 'did',
        portType: 'did',
        required: true,
        description: 'Oracle DID, typically from the wallet.generate output.',
      },
      {
        path: 'pubKey',
        portType: 'string',
        required: true,
        description:
          'Oracle wallet public key, typically from the wallet.generate output.',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description:
          'PIN used to sign the entity creation; typically from the form output.',
      },
      {
        path: 'matrixAccessToken',
        portType: 'string',
        required: true,
        description:
          'Oracle Matrix access token, typically from the matrix.register output.',
      },
      {
        path: 'matrixRoomId',
        portType: 'roomId',
        required: true,
        description:
          'Oracle Matrix room id, typically from the matrix.register output.',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Display name of the oracle.',
      },
      {
        path: 'apiUrl',
        portType: 'string',
        required: true,
        description: 'Oracle API URL.',
      },
      {
        path: 'price',
        portType: 'string',
        required: true,
        description: 'Oracle subscription price.',
      },
      {
        path: 'orgName',
        portType: 'string',
        description: 'Optional organization name.',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional oracle description.',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional oracle location.',
      },
      {
        path: 'logoUrl',
        portType: 'string',
        description: 'Optional oracle logo URL.',
      },
      {
        path: 'coverImageUrl',
        portType: 'string',
        description: 'Optional oracle cover image URL.',
      },
      {
        path: 'llmModel',
        portType: 'string',
        description: 'Optional LLM model identifier.',
      },
      {
        path: 'opening',
        portType: 'string',
        description: 'Optional oracle opening message.',
      },
      {
        path: 'communicationStyle',
        portType: 'string',
        description: 'Optional oracle communication style.',
      },
      {
        path: 'capabilities',
        portType: 'array',
        description: 'Optional oracle capabilities.',
      },
      {
        path: 'mcpConfig',
        portType: 'object',
        description: 'Optional MCP configuration.',
      },
      {
        path: 'parentProtocol',
        portType: 'string',
        description: 'Optional parent protocol DID.',
      },
      {
        path: 'formAnswers',
        portType: 'string',
        description:
          'Optional JSON string of form answers; parsed and merged under the explicit inputs.',
      },
    ],
    requires: [
      {
        kind: 'oracleDetails',
        description:
          'Oracle name, API URL, and price (plus optional org/description/branding/LLM settings) — ask the user.',
      },
      {
        kind: 'pin',
        description: 'A PIN used to sign the entity creation — ask the user.',
      },
    ],
  },
  oracle: {
    summary:
      'Sends a prompt to the companion assistant via the askCompanion handler. Read-only — no on-chain, Matrix, or sandbox side effect.',
    whenToUse: [
      'An automation needs to ask the in-app companion/assistant a question.',
    ],
    whenNotToUse: [
      'Do not use for the oracle-creation pipeline — this is an unrelated companion-prompt action, not an oracle setup step.',
    ],
    tags: ['companion', 'prompt'],
    inputPorts: [
      {
        path: 'prompt',
        portType: 'string',
        required: true,
        description: 'The prompt text sent to the companion.',
      },
    ],
  },
  'qi/oracle.contract': {
    summary:
      'Contracts the oracle by ensuring the user-oracle Matrix DM room exists and the user has joined it, returning that room id. Matrix state side effect only — no chain calls.',
    whenToUse: [
      'As the step that opens the user-oracle DM room before storing secrets/config, after the oracle entity exists.',
    ],
    tags: ['oracle', 'matrix', 'contract'],
    inputPorts: [
      {
        path: 'oracleEntityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
    ],
  },
  'qi/oracle.configureOracle': {
    summary:
      'Runs the full configure pipeline in one action: contracts the oracle (opens the user-oracle Matrix room), then JWE-encrypts and stores oracle secrets, then stores the oracle config — all into that room. Matrix state side effect.',
    whenToUse: [
      'As the one-shot configure step that contracts the oracle and writes both secrets and config in sequence.',
    ],
    whenNotToUse: [
      'Use this when you also need the contract phase; if the user-oracle room already exists and you only need to write secrets+config, use qi/oracle.storeSecretsAndConfig instead.',
    ],
    tags: ['oracle', 'configure', 'matrix', 'secrets'],
    inputPorts: [
      {
        path: 'oracleEntityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
      {
        path: 'publicKeyMultibase',
        portType: 'string',
        required: true,
        description:
          'Oracle encryption public key (multibase), from the entity.createOracle output.',
      },
      {
        path: 'verificationMethodId',
        portType: 'string',
        required: true,
        description:
          'Encryption verification method id, from the entity.createOracle output.',
      },
      {
        path: 'matrixHomeServerUrl',
        portType: 'string',
        required: true,
        description: 'Matrix homeserver URL, from the matrix.register output.',
      },
      {
        path: 'matrixUsername',
        portType: 'string',
        required: true,
        description:
          'Matrix username, from the matrix.register output (matrixUserId).',
      },
      {
        path: 'matrixPassword',
        portType: 'string',
        required: true,
        description: 'Matrix password, from the matrix.register output.',
      },
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Oracle wallet mnemonic, from the wallet.generate output; stored as SECP_MNEMONIC secret.',
      },
      {
        path: 'matrixRecoveryPhrase',
        portType: 'string',
        required: true,
        description: 'Matrix recovery phrase, from the matrix.register output.',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description:
          'PIN, from the form output; stored as MATRIX_VALUE_PIN secret.',
      },
      {
        path: 'openRouterApiKeyJwe',
        portType: 'string',
        required: true,
        description:
          'JWE-encrypted OpenRouter API key from the form (must be pre-encrypted before submit).',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Oracle name.',
      },
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, written into the stored config.',
      },
      {
        path: 'openRouterApiKeyPlaintext',
        portType: 'string',
        description:
          'Optional plaintext OpenRouter API key passed through to the deploy output.',
      },
      {
        path: 'mcpAuthSecrets',
        portType: 'object',
        description:
          'Optional pre-encrypted MCP auth secrets (object or JSON string), merged into the stored secrets.',
      },
      {
        path: 'orgName',
        portType: 'string',
        description: 'Optional organisation name.',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional oracle description.',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional oracle location.',
      },
      {
        path: 'price',
        portType: 'number',
        description: 'Optional oracle price; defaults to 0.',
      },
      {
        path: 'apiUrl',
        portType: 'string',
        description: 'Optional oracle API URL.',
      },
      {
        path: 'logoUrl',
        portType: 'string',
        description: 'Optional oracle logo URL.',
      },
      {
        path: 'llmModel',
        portType: 'string',
        description: 'Optional LLM model identifier.',
      },
      {
        path: 'opening',
        portType: 'string',
        description: 'Optional oracle opening message.',
      },
      {
        path: 'communicationStyle',
        portType: 'string',
        description: 'Optional oracle communication style.',
      },
      {
        path: 'capabilities',
        portType: 'string',
        description: 'Optional oracle capabilities description.',
      },
      {
        path: 'skills',
        portType: 'array',
        description: 'Optional list of oracle skills.',
      },
      {
        path: 'mcpServers',
        portType: 'array',
        description: 'Optional list of configured MCP servers.',
      },
      {
        path: 'matrixUserId',
        portType: 'string',
        description: 'Optional oracle Matrix user id.',
      },
      {
        path: 'matrixAccountRoomId',
        portType: 'roomId',
        description: 'Optional oracle Matrix account room id.',
      },
      {
        path: 'oracleAddress',
        portType: 'chainAddress',
        description: 'Optional oracle wallet address.',
      },
      {
        path: 'oracleDid',
        portType: 'did',
        description: 'Optional oracle DID.',
      },
      {
        path: 'formAnswers',
        portType: 'string',
        description:
          'Optional JSON string of form answers; parsed and merged under the explicit inputs.',
      },
    ],
    requires: [
      {
        kind: 'openRouterApiKey',
        description:
          'An OpenRouter API key, JWE-encrypted before submit (openRouterApiKeyJwe) — ask the user.',
      },
      { kind: 'pin', description: 'A PIN stored as a secret — ask the user.' },
    ],
  },
  'qi/oracle.storeSecrets': {
    summary:
      'JWE-encrypts and writes the oracle secrets (SECP_MNEMONIC, Matrix admin password, recovery phrase, PIN, encrypted OpenRouter key, optional MCP auth secrets) into the user-oracle Matrix room via a fresh mxLogin. Matrix state side effect.',
    whenToUse: [
      'As the secrets step after qi/oracle.contract, when you want to store secrets separately from config.',
    ],
    whenNotToUse: [
      'If you also need to store the oracle config in the same step, use qi/oracle.storeSecretsAndConfig; this action writes secrets only.',
    ],
    tags: ['oracle', 'secrets', 'matrix'],
    inputPorts: [
      {
        path: 'matrixRoomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle.contract output.',
      },
      {
        path: 'publicKeyMultibase',
        portType: 'string',
        required: true,
        description:
          'Oracle encryption public key (multibase), from the entity.createOracle output.',
      },
      {
        path: 'verificationMethodId',
        portType: 'string',
        required: true,
        description:
          'Encryption verification method id, from the entity.createOracle output.',
      },
      {
        path: 'matrixHomeServerUrl',
        portType: 'string',
        required: true,
        description: 'Matrix homeserver URL, from the matrix.register output.',
      },
      {
        path: 'matrixUsername',
        portType: 'string',
        required: true,
        description:
          'Matrix username, from the matrix.register output (matrixUserId).',
      },
      {
        path: 'matrixPassword',
        portType: 'string',
        required: true,
        description: 'Matrix password, from the matrix.register output.',
      },
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Oracle wallet mnemonic, from the wallet.generate output; stored as SECP_MNEMONIC.',
      },
      {
        path: 'matrixRecoveryPhrase',
        portType: 'string',
        required: true,
        description: 'Matrix recovery phrase, from the matrix.register output.',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description: 'PIN, from the form output; stored as MATRIX_VALUE_PIN.',
      },
      {
        path: 'openRouterApiKeyJwe',
        portType: 'string',
        required: true,
        description:
          'JWE-encrypted OpenRouter API key from the form (must be pre-encrypted before submit).',
      },
      {
        path: 'mcpAuthSecrets',
        portType: 'object',
        description:
          'Optional pre-encrypted MCP auth secrets (object or JSON string), merged into the stored secrets.',
      },
    ],
    requires: [
      {
        kind: 'openRouterApiKey',
        description:
          'An OpenRouter API key, JWE-encrypted before submit (openRouterApiKeyJwe) — ask the user.',
      },
      { kind: 'pin', description: 'A PIN stored as a secret — ask the user.' },
    ],
  },
  'qi/oracle.storeConfig': {
    summary:
      'Writes the oracle config (name, org, description, pricing, branding, LLM/communication settings, skills, MCP servers, identity refs) as a state event into the user-oracle Matrix room. Matrix state side effect.',
    whenToUse: [
      'As the config step after secrets are stored, to persist the oracle public configuration into its Matrix room.',
    ],
    whenNotToUse: [
      'If you also need to store secrets in the same step, use qi/oracle.storeSecretsAndConfig; this action writes config only.',
    ],
    tags: ['oracle', 'config', 'matrix'],
    inputPorts: [
      {
        path: 'matrixRoomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle.contract output.',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Oracle name.',
      },
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
      {
        path: 'orgName',
        portType: 'string',
        description: 'Optional organisation name.',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional oracle description.',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional oracle location.',
      },
      {
        path: 'price',
        portType: 'number',
        description: 'Optional oracle price; defaults to 0.',
      },
      {
        path: 'apiUrl',
        portType: 'string',
        description: 'Optional oracle API URL.',
      },
      {
        path: 'logoUrl',
        portType: 'string',
        description: 'Optional oracle logo URL.',
      },
      {
        path: 'llmModel',
        portType: 'string',
        description: 'Optional LLM model identifier.',
      },
      {
        path: 'opening',
        portType: 'string',
        description: 'Optional oracle opening message.',
      },
      {
        path: 'communicationStyle',
        portType: 'string',
        description: 'Optional oracle communication style.',
      },
      {
        path: 'capabilities',
        portType: 'string',
        description: 'Optional oracle capabilities description.',
      },
      {
        path: 'skills',
        portType: 'array',
        description: 'Optional list of oracle skills.',
      },
      {
        path: 'mcpServers',
        portType: 'array',
        description: 'Optional list of configured MCP servers.',
      },
      {
        path: 'matrixUserId',
        portType: 'string',
        description: 'Optional oracle Matrix user id.',
      },
      {
        path: 'matrixAccountRoomId',
        portType: 'roomId',
        description: 'Optional oracle Matrix account room id.',
      },
      {
        path: 'oracleAddress',
        portType: 'chainAddress',
        description: 'Optional oracle wallet address.',
      },
      {
        path: 'oracleDid',
        portType: 'did',
        description: 'Optional oracle DID.',
      },
    ],
  },
  'qi/oracle.storeSecretsAndConfig': {
    summary:
      'Combined step: JWE-encrypts and stores the oracle secrets, then stores the oracle config, both into the existing user-oracle Matrix room. Matrix state side effect. Does NOT contract the room.',
    whenToUse: [
      'As the combined secrets+config step after qi/oracle.contract, when the user-oracle room already exists.',
    ],
    whenNotToUse: [
      'If the user-oracle room does not exist yet, use qi/oracle.configureOracle (which contracts first); use qi/oracle.storeSecrets or qi/oracle.storeConfig if you only need one of the two writes.',
    ],
    tags: ['oracle', 'secrets', 'config', 'matrix'],
    inputPorts: [
      {
        path: 'matrixRoomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle.contract output.',
      },
      {
        path: 'publicKeyMultibase',
        portType: 'string',
        required: true,
        description:
          'Oracle encryption public key (multibase), from the entity.createOracle output.',
      },
      {
        path: 'verificationMethodId',
        portType: 'string',
        required: true,
        description:
          'Encryption verification method id, from the entity.createOracle output.',
      },
      {
        path: 'matrixHomeServerUrl',
        portType: 'string',
        required: true,
        description: 'Matrix homeserver URL, from the matrix.register output.',
      },
      {
        path: 'matrixUsername',
        portType: 'string',
        required: true,
        description:
          'Matrix username, from the matrix.register output (matrixUserId).',
      },
      {
        path: 'matrixPassword',
        portType: 'string',
        required: true,
        description: 'Matrix password, from the matrix.register output.',
      },
      {
        path: 'mnemonic',
        portType: 'mnemonic',
        required: true,
        description:
          'Oracle wallet mnemonic, from the wallet.generate output; stored as SECP_MNEMONIC.',
      },
      {
        path: 'matrixRecoveryPhrase',
        portType: 'string',
        required: true,
        description: 'Matrix recovery phrase, from the matrix.register output.',
      },
      {
        path: 'pin',
        portType: 'string',
        required: true,
        description: 'PIN, from the form output; stored as MATRIX_VALUE_PIN.',
      },
      {
        path: 'openRouterApiKeyJwe',
        portType: 'string',
        required: true,
        description:
          'JWE-encrypted OpenRouter API key from the form (must be pre-encrypted before submit).',
      },
      {
        path: 'oracleName',
        portType: 'string',
        required: true,
        description: 'Oracle name.',
      },
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
      {
        path: 'mcpAuthSecrets',
        portType: 'object',
        description:
          'Optional pre-encrypted MCP auth secrets (object or JSON string), merged into the stored secrets.',
      },
      {
        path: 'orgName',
        portType: 'string',
        description: 'Optional organisation name.',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional oracle description.',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional oracle location.',
      },
      {
        path: 'price',
        portType: 'number',
        description: 'Optional oracle price; defaults to 0.',
      },
      {
        path: 'apiUrl',
        portType: 'string',
        description: 'Optional oracle API URL.',
      },
      {
        path: 'logoUrl',
        portType: 'string',
        description: 'Optional oracle logo URL.',
      },
      {
        path: 'llmModel',
        portType: 'string',
        description: 'Optional LLM model identifier.',
      },
      {
        path: 'opening',
        portType: 'string',
        description: 'Optional oracle opening message.',
      },
      {
        path: 'communicationStyle',
        portType: 'string',
        description: 'Optional oracle communication style.',
      },
      {
        path: 'capabilities',
        portType: 'string',
        description: 'Optional oracle capabilities description.',
      },
      {
        path: 'skills',
        portType: 'array',
        description: 'Optional list of oracle skills.',
      },
      {
        path: 'mcpServers',
        portType: 'array',
        description: 'Optional list of configured MCP servers.',
      },
      {
        path: 'matrixUserId',
        portType: 'string',
        description: 'Optional oracle Matrix user id.',
      },
      {
        path: 'matrixAccountRoomId',
        portType: 'roomId',
        description: 'Optional oracle Matrix account room id.',
      },
      {
        path: 'oracleAddress',
        portType: 'chainAddress',
        description: 'Optional oracle wallet address.',
      },
      {
        path: 'oracleDid',
        portType: 'did',
        description: 'Optional oracle DID.',
      },
    ],
    requires: [
      {
        kind: 'openRouterApiKey',
        description:
          'An OpenRouter API key, JWE-encrypted before submit (openRouterApiKeyJwe) — ask the user.',
      },
      { kind: 'pin', description: 'A PIN stored as a secret — ask the user.' },
    ],
  },
  'qi/oracle.deploy': {
    summary:
      'Full deploy step: runs deploy setup (build), then deploy start (launches the oracle process), then if a URL is returned broadcasts an on-chain domain update to point the entity at the new deployment URL. Sandbox/process provisioning plus an on-chain tx side effect.',
    whenToUse: [
      'As the final deploy step of the oracle-creation flow, after secrets and config are stored.',
    ],
    whenNotToUse: [
      'If you need to run the build and launch phases as separate blocks, use qi/oracle.deploySetup and qi/oracle.deployStart instead of this combined action.',
    ],
    tags: ['oracle', 'deploy', 'onchain'],
    inputPorts: [
      {
        path: 'name',
        portType: 'string',
        required: true,
        description: 'Project name, from the form.',
      },
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
      {
        path: 'roomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle.configureOracle output.',
      },
      {
        path: 'config',
        portType: 'object',
        required: true,
        description: 'Oracle config object (or its JSON string).',
      },
      {
        path: 'secrets',
        portType: 'object',
        description: 'Optional map of secret name to value passed to deploy.',
      },
    ],
  },
  'qi/oracle.deploySetup': {
    summary:
      'Runs the oracle deploy setup (build) phase for the project, writing build output. Sandbox/process provisioning side effect; does not launch the running process.',
    whenToUse: [
      'As the build phase of a split deploy, before qi/oracle.deployStart.',
    ],
    whenNotToUse: [
      'This only builds — it does not start the oracle process or update the on-chain domain; pair it with qi/oracle.deployStart, or use qi/oracle.deploy to do everything in one block.',
    ],
    tags: ['oracle', 'deploy', 'setup'],
    inputPorts: [
      {
        path: 'name',
        portType: 'string',
        required: true,
        description: 'Project name, from the form.',
      },
      {
        path: 'config',
        portType: 'object',
        required: true,
        description: 'Oracle config object (or its JSON string).',
      },
      {
        path: 'roomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle contract/configure output.',
      },
      {
        path: 'secrets',
        portType: 'object',
        description:
          'Optional map of secret name to value passed to deploy setup.',
      },
    ],
  },
  'qi/oracle.deployStart': {
    summary:
      'Launches the oracle running process for the project and returns its process id/status. Sandbox/process provisioning side effect; does not run the build or update the on-chain domain.',
    whenToUse: [
      'As the launch phase of a split deploy, after qi/oracle.deploySetup.',
    ],
    whenNotToUse: [
      'This starts the process only — run qi/oracle.deploySetup first for the build, and note it does not update the on-chain domain (qi/oracle.deploy does that).',
    ],
    tags: ['oracle', 'deploy', 'start'],
    inputPorts: [
      {
        path: 'name',
        portType: 'string',
        required: true,
        description: 'Project name, from the form.',
      },
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description: 'Oracle entity DID, from the entity.createOracle output.',
      },
      {
        path: 'roomId',
        portType: 'roomId',
        required: true,
        description:
          'User-oracle Matrix room id, from the oracle contract/configure output.',
      },
      {
        path: 'secrets',
        portType: 'object',
        description:
          'Optional map of secret name to value passed to deploy start.',
      },
    ],
  },
  'qi/sandbox.provision': {
    summary:
      'Provisions a sandbox for the oracle entity and returns the sandbox URL and status. Sandbox provisioning side effect.',
    whenToUse: [
      'As the step that spins up a sandbox environment for an oracle entity.',
    ],
    tags: ['oracle', 'sandbox', 'provision'],
    inputPorts: [
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description:
          'Oracle entity DID to provision a sandbox for, from the entity.createOracle output.',
      },
      {
        path: 'matrixRoomId',
        portType: 'roomId',
        required: true,
        description:
          'Matrix room id associated with the oracle, from the oracle.contract output.',
      },
    ],
  },

  // ── POD setup ─────────────────────────────────────────────────────────────
  'qi/pod.domain-indexer-lookup': {
    summary:
      'AI-assisted intent capture that takes a free-text purpose and queries the Domain Indexer for matching Blueprint candidates, returning a ranked list. Currently a stub that records the purpose and returns an empty candidate array; no real chain/indexer call yet.',
    whenToUse: [
      "Step 1 of POD setup — capture the user's purpose and surface candidate blueprints to choose from.",
    ],
    tags: ['pod', 'setup'],
    inputPorts: [
      {
        path: 'userMessage',
        portType: 'string',
        required: true,
        description:
          'User-provided purpose text used to query the Domain Indexer (run() throws if both this and purposeDescription are empty).',
      },
      {
        path: 'purposeDescription',
        portType: 'string',
        description: 'Fallback purpose text used when userMessage is absent.',
      },
    ],
  },
  'qi/pod.domain-single-selection': {
    summary:
      "Records the user's single Blueprint (protocol entity) selection and carries the blueprint DID forward to all later POD setup steps. Pure selection step — no chain/indexer read; it normalizes the DID and emits a derived entity context entry (class = blueprint DID).",
    whenToUse: [
      'Step 2 of POD setup — lock in the Blueprint DID that the new POD will be created from.',
    ],
    whenNotToUse: [
      'Selecting a parent organisation/DAO — use qi/pod.entity-single-selection.',
      'Selecting POD members — use qi/pod.member-multi-select.',
    ],
    tags: ['pod', 'setup'],
    inputPorts: [
      {
        path: 'selectedBlueprintDid',
        portType: 'did',
        required: true,
        description:
          'DID of the blueprint to select (run() throws if it cannot be extracted to a valid DID).',
      },
      {
        path: 'selectedBlueprintName',
        portType: 'string',
        description: 'Display name of the selected blueprint.',
      },
      {
        path: 'selectedBlueprintDescription',
        portType: 'string',
        description: 'Description of the selected blueprint.',
      },
    ],
    requires: [
      {
        kind: 'blueprintDid',
        description:
          'A candidate Blueprint DID must be available to select (typically from the prior domain-indexer-lookup step).',
      },
    ],
  },
  'qi/pod.entity-single-selection': {
    summary:
      'Optionally records a single parent organisation (DAO/POD) for the new POD, setting parentDID. Pure selection step with no chain read; supports an explicit skip path that leaves the parent DID null.',
    whenToUse: [
      'Step 3A of POD setup — optionally attach the new POD to a parent DAO/POD the user controls.',
    ],
    whenNotToUse: [
      'Selecting the Blueprint the POD is built from — use qi/pod.domain-single-selection.',
    ],
    tags: ['pod', 'setup'],
    inputPorts: [
      {
        path: 'skipped',
        portType: 'boolean',
        description:
          'Set true to skip selecting a parent entity, leaving parentDID null.',
      },
      {
        path: 'selectedEntityDid',
        portType: 'did',
        required: true,
        description:
          'DID of the parent entity; required when not skipping (run() throws if absent and skipped is falsy).',
      },
      {
        path: 'selectedEntityName',
        portType: 'string',
        description: 'Display name of the selected parent entity.',
      },
      {
        path: 'selectedEntityType',
        portType: 'string',
        description: 'Entity type of the selected parent entity.',
      },
    ],
  },
  'qi/pod.governance-config': {
    summary:
      'Validates and records the governance group type and its Cosmos group DecisionPolicy. No chain write — it enforces type-specific rules (multisig requires a positive-integer threshold; weighted types require quorum/threshold in 0–1 and threshold+vetoThreshold <= 1) and carries the config forward to drive the membership step.',
    whenToUse: [
      'Step 4 of POD setup — choose the governance model (categorical, multisig, nftStaking, tokenStaking) and set the decision policy.',
    ],
    tags: ['pod', 'governance'],
    inputPorts: [
      {
        path: 'groupName',
        portType: 'string',
        required: true,
        description:
          'Human-readable governance group name (run() throws if empty).',
      },
      {
        path: 'groupType',
        portType: 'string',
        required: true,
        description:
          'One of categorical | multisig | nftStaking | tokenStaking (run() throws if missing or invalid).',
      },
      {
        path: 'governance',
        portType: 'object',
        required: true,
        description:
          'Cosmos group decision policy params; must include votingPeriod, plus threshold for multisig or quorum/threshold for weighted types (run() throws if missing or invalid).',
      },
    ],
  },
  'qi/pod.list-domain-flows': {
    summary:
      'Records a multi-select of protocol deeds and their Matrix flow templates to import after the POD is created. Pure selection step; normalizes the chosen templates (each needs protocolDid + sourceRoomId), and an empty selection is valid (POD created without imported flows).',
    whenToUse: [
      'Step 3D of POD setup — choose which protocol flow templates the new POD should import.',
    ],
    tags: ['pod', 'setup'],
    inputPorts: [
      {
        path: 'selectedProtocolTemplates',
        portType: 'array',
        description:
          'Selected protocol templates, each with protocolDid and sourceRoomId; empty selection is valid.',
      },
      {
        path: 'selectedFlowDids',
        portType: 'array',
        description:
          'Source Matrix room IDs for selected templates; used as a fallback when no templates are selected.',
      },
    ],
  },
  'qi/pod.member-multi-select': {
    summary:
      'Validates and records POD membership, with required fields driven by the governance groupType from the previous step: categorical needs members with an Admin role and positive-integer voting power; multisig needs members plus an integer threshold not exceeding member count; nftStaking needs an NFT contract address; tokenStaking needs a token config. No chain write — selection/config only, with duplicate-DID rejection.',
    whenToUse: [
      "Step 5 of POD setup — define the POD's members or staking config according to the chosen governance type.",
    ],
    whenNotToUse: [
      'Selecting the Blueprint or a parent entity — use qi/pod.domain-single-selection or qi/pod.entity-single-selection.',
    ],
    tags: ['pod', 'governance'],
    inputPorts: [
      {
        path: 'groupType',
        portType: 'string',
        description:
          'Governance group type that determines which fields apply; defaults to categorical.',
      },
      {
        path: 'members',
        portType: 'array',
        description:
          'Array of { did, role, votingPower }; required (non-empty) for categorical and multisig — categorical needs an Admin and positive-integer voting power per member.',
      },
      {
        path: 'multisigThreshold',
        portType: 'number',
        description:
          'Minimum signers required; must be a positive integer not exceeding member count — multisig only.',
      },
      {
        path: 'nftContractAddress',
        portType: 'chainAddress',
        description:
          'NFT staking contract address; required for nftStaking groups.',
      },
      {
        path: 'tokenConfig',
        portType: 'object',
        description:
          'Token config; required for tokenStaking — needs tokenAddress when existing, else tokenName/tokenSymbol/positive tokenSupply.',
      },
    ],
    requires: [
      {
        kind: 'governanceGroupType',
        description:
          'The governance groupType from the prior governance-config step, which decides which member fields are required.',
      },
    ],
  },

  // ── Calendar & Xero integrations ──────────────────────────────────────────
  'qi/calendar.event.create': {
    summary:
      'Create a new event on a connected Google Calendar via the GOOGLECALENDAR_CREATE_EVENT integration tool (Composio).',
    whenToUse: [
      'An automation needs to schedule/book a new calendar event for someone.',
      'A flow has resolved a start time (and optionally attendees) and should write a fresh event to a Google Calendar.',
    ],
    whenNotToUse: [
      'To modify an event that already exists — use qi/calendar.event.update (which requires an event_id) instead of creating a duplicate.',
    ],
    tags: ['integration', 'calendar', 'google'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Google Calendar connection object carrying connectedAccountId and entityDid. Comes from the connected integration account, not an upstream block.',
      },
      {
        path: 'start_datetime',
        portType: 'string',
        required: true,
        description: 'Event start time in ISO 8601. run() throws if blank.',
      },
      {
        path: 'end_datetime',
        portType: 'string',
        description: 'Optional event end time in ISO 8601.',
      },
      {
        path: 'calendar_id',
        portType: 'string',
        description: 'Calendar to write to; defaults to "primary".',
      },
      {
        path: 'summary',
        portType: 'string',
        description: 'Optional event title.',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional event description.',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional event location.',
      },
      {
        path: 'timezone',
        portType: 'string',
        description: 'Optional timezone for the event.',
      },
      {
        path: 'send_updates',
        portType: 'string',
        description:
          'Optional attendee-notification mode passed through to Calendar.',
      },
      {
        path: 'attendees',
        portType: 'string',
        description:
          'Optional attendees as a JSON array, or newline-/comma-separated email list.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Google Calendar account (connectedAccountId) pinned on the block — ask the user to connect Calendar before running.',
      },
    ],
  },
  'qi/calendar.event.list': {
    summary:
      'List/search events from a connected Google Calendar via the GOOGLECALENDAR_EVENTS_LIST integration tool (Composio). Read-only, no side effect.',
    whenToUse: [
      'A flow needs to look up existing events (optionally filtered by time window or free-text query) before acting.',
      'You need an event id from the calendar to feed a downstream qi/calendar.event.update block.',
    ],
    tags: ['integration', 'calendar', 'google', 'read'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Google Calendar connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'calendarId',
        portType: 'string',
        description:
          'Calendar to list from; defaults to "primary". Note camelCase here (list tool) vs snake_case calendar_id on create/update.',
      },
      {
        path: 'q',
        portType: 'string',
        description: 'Optional free-text search query for events.',
      },
      {
        path: 'timeMin',
        portType: 'string',
        description: 'Optional lower bound for event start time (ISO 8601).',
      },
      {
        path: 'timeMax',
        portType: 'string',
        description: 'Optional upper bound for event start time (ISO 8601).',
      },
      {
        path: 'timeZone',
        portType: 'string',
        description: 'Optional timezone for the returned times.',
      },
      {
        path: 'orderBy',
        portType: 'string',
        description: 'Optional ordering of results (e.g. startTime).',
      },
      {
        path: 'singleEvents',
        portType: 'boolean',
        description:
          'Optional flag to expand recurring events into single instances.',
      },
      {
        path: 'maxResults',
        portType: 'string',
        description:
          'Optional max number of events to return (parsed as a positive integer).',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Google Calendar account (connectedAccountId) pinned on the block — ask the user to connect Calendar before running.',
      },
    ],
  },
  'qi/calendar.event.update': {
    summary:
      'Update an existing Google Calendar event via the GOOGLECALENDAR_UPDATE_EVENT integration tool (Composio). This is a full PUT — omitted fields are cleared.',
    whenToUse: [
      'A flow needs to reschedule or edit an existing calendar event identified by its event_id.',
      'You have an event id (e.g. from qi/calendar.event.list) and want to change its time, title, attendees, etc.',
    ],
    whenNotToUse: [
      'To create a brand-new event — use qi/calendar.event.create. Also note this is a full replace, so unspecified fields are cleared, not preserved.',
    ],
    tags: ['integration', 'calendar', 'google'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Google Calendar connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'event_id',
        portType: 'eventId',
        required: true,
        description:
          'Identifier of the existing event to update. run() throws if blank; wire from qi/calendar.event.list output or an upstream create.',
      },
      {
        path: 'start_datetime',
        portType: 'string',
        required: true,
        description: 'Event start time in ISO 8601. run() throws if blank.',
      },
      {
        path: 'end_datetime',
        portType: 'string',
        description: 'Optional event end time in ISO 8601.',
      },
      {
        path: 'calendar_id',
        portType: 'string',
        description: 'Calendar containing the event; defaults to "primary".',
      },
      {
        path: 'summary',
        portType: 'string',
        description: 'Optional event title (cleared if omitted — full PUT).',
      },
      {
        path: 'description',
        portType: 'string',
        description: 'Optional event description (cleared if omitted).',
      },
      {
        path: 'location',
        portType: 'string',
        description: 'Optional event location (cleared if omitted).',
      },
      {
        path: 'timezone',
        portType: 'string',
        description: 'Optional timezone for the event.',
      },
      {
        path: 'send_updates',
        portType: 'string',
        description:
          'Optional attendee-notification mode passed through to Calendar.',
      },
      {
        path: 'attendees',
        portType: 'string',
        description:
          'Optional attendees as a JSON array, or newline-/comma-separated email list.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Google Calendar account (connectedAccountId) pinned on the block — ask the user to connect Calendar before running.',
      },
      {
        kind: 'eventId',
        description:
          'The id of an existing calendar event to update — ask the user or source it from a qi/calendar.event.list / create step.',
      },
    ],
  },
  'qi/xero.contact.create': {
    summary:
      'Create a contact (customer/supplier) in a connected Xero organisation via the XERO_CREATE_CONTACT integration tool (Composio).',
    whenToUse: [
      'A flow needs a Xero contact to exist before issuing an invoice to them.',
      'Onboarding a new customer or supplier into the bookkeeping system.',
    ],
    tags: ['integration', 'xero', 'accounting'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Xero connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'Name',
        portType: 'string',
        required: true,
        description: 'Contact display name. run() throws if blank.',
      },
      {
        path: 'tenant_id',
        portType: 'string',
        description: 'Xero org identifier; empty uses the connection default.',
      },
      {
        path: 'FirstName',
        portType: 'string',
        description: 'Contact first name.',
      },
      {
        path: 'LastName',
        portType: 'string',
        description: 'Contact last name.',
      },
      {
        path: 'EmailAddress',
        portType: 'string',
        description: 'Contact email address.',
      },
      {
        path: 'phone_number',
        portType: 'string',
        description: 'Contact phone number.',
      },
      {
        path: 'mobile_number',
        portType: 'string',
        description: 'Contact mobile number.',
      },
      {
        path: 'Website',
        portType: 'string',
        description: 'Contact website URL.',
      },
      {
        path: 'TaxNumber',
        portType: 'string',
        description: 'Contact tax number.',
      },
      {
        path: 'AccountNumber',
        portType: 'string',
        description: 'Contact account number.',
      },
      {
        path: 'DefaultCurrency',
        portType: 'string',
        description: 'Default currency code for the contact.',
      },
      {
        path: 'BankAccountDetails',
        portType: 'string',
        description: 'Contact bank account details.',
      },
      {
        path: 'IsCustomer',
        portType: 'boolean',
        description: 'Whether the contact is a customer.',
      },
      {
        path: 'IsSupplier',
        portType: 'boolean',
        description: 'Whether the contact is a supplier.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Xero account (connectedAccountId) pinned on the block — ask the user to connect Xero before running.',
      },
    ],
  },
  'qi/xero.invoice.create': {
    summary:
      'Create an invoice (sales ACCREC or bill ACCPAY) with line items in a connected Xero organisation via the XERO_CREATE_INVOICE integration tool (Composio).',
    whenToUse: [
      'A flow needs to bill a customer or record a supplier bill in Xero.',
      'You have finalised line items and a contact and want to issue an invoice.',
    ],
    whenNotToUse: [
      'To record money received against an invoice — use qi/xero.payment.create. To look up existing invoices — use qi/xero.invoice.list.',
    ],
    tags: ['integration', 'xero', 'accounting'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Xero connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'LineItems',
        portType: 'array',
        required: true,
        description:
          'Finalised array of invoice line-item objects (resolved from manual rows or an iterative upstream-array binding before run()). run() throws if empty.',
      },
      {
        path: 'tenant_id',
        portType: 'string',
        description: 'Xero org identifier; empty uses the connection default.',
      },
      {
        path: 'Type',
        portType: 'string',
        description:
          "Invoice type 'ACCREC' (sale) or 'ACCPAY' (bill); defaults to ACCREC. run() throws on any other value.",
      },
      {
        path: 'Status',
        portType: 'string',
        description: 'Invoice status (e.g. DRAFT, AUTHORISED).',
      },
      { path: 'Date', portType: 'string', description: 'Invoice date.' },
      { path: 'DueDate', portType: 'string', description: 'Invoice due date.' },
      {
        path: 'ContactID',
        portType: 'string',
        description:
          'Xero contact UUID; preferred over ContactName. Wire from qi/xero.contact.create output.',
      },
      {
        path: 'ContactName',
        portType: 'string',
        description:
          'Contact name fallback used only when ContactID is absent.',
      },
      {
        path: 'Reference',
        portType: 'string',
        description: 'Invoice reference text.',
      },
      {
        path: 'InvoiceNumber',
        portType: 'string',
        description: 'Invoice number.',
      },
      {
        path: 'CurrencyCode',
        portType: 'string',
        description: 'Invoice currency code.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Xero account (connectedAccountId) pinned on the block — ask the user to connect Xero before running.',
      },
    ],
  },
  'qi/xero.invoice.list': {
    summary:
      'List/search invoices from a connected Xero organisation via the XERO_LIST_INVOICES integration tool (Composio). Read-only, no side effect.',
    whenToUse: [
      'A flow needs to find existing invoices (filtered by status, contact, ids, or a where-clause) before acting.',
      'You need an InvoiceID to feed a downstream qi/xero.payment.create block.',
    ],
    whenNotToUse: ['To create a new invoice — use qi/xero.invoice.create.'],
    tags: ['integration', 'xero', 'accounting', 'read'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Xero connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'tenantId',
        portType: 'string',
        description:
          'Xero org identifier (camelCase tenantId for the list tool, vs snake_case tenant_id on create).',
      },
      {
        path: 'page',
        portType: 'string',
        description: 'Page number; parsed to an integer >= 1.',
      },
      {
        path: 'order',
        portType: 'string',
        description: 'Sort order expression.',
      },
      {
        path: 'Statuses',
        portType: 'string',
        description: 'Filter by invoice statuses.',
      },
      {
        path: 'ContactIDs',
        portType: 'string',
        description: 'Filter by contact IDs.',
      },
      {
        path: 'InvoiceIDs',
        portType: 'string',
        description: 'Filter by invoice IDs.',
      },
      {
        path: 'where',
        portType: 'string',
        description: 'Xero where-clause filter expression.',
      },
      {
        path: 'createdByMyApp',
        portType: 'boolean',
        description: 'Limit to invoices created by this app.',
      },
      {
        path: 'includeArchived',
        portType: 'boolean',
        description: 'Include archived invoices.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Xero account (connectedAccountId) pinned on the block — ask the user to connect Xero before running.',
      },
    ],
  },
  'qi/xero.payment.create': {
    summary:
      'Record a payment against an existing Xero invoice via the XERO_CREATE_PAYMENT integration tool (Composio) — the settlement step that marks an invoice/bill paid in the books.',
    whenToUse: [
      'Settle/mark an existing (AUTHORISED) Xero invoice as paid after a payout.',
      'Reconcile an on-chain transaction against an invoice by passing the tx hash as Reference.',
    ],
    whenNotToUse: [
      'To create the invoice itself — use qi/xero.invoice.create first; payment.create requires an existing InvoiceID. To find invoices — use qi/xero.invoice.list.',
    ],
    tags: ['integration', 'xero', 'accounting', 'payment'],
    inputPorts: [
      {
        path: 'connection',
        portType: 'object',
        required: true,
        description:
          'Pinned Xero connection object carrying connectedAccountId and entityDid.',
      },
      {
        path: 'InvoiceID',
        portType: 'invoiceId',
        required: true,
        description:
          'UUID of the invoice being paid. run() throws if blank; usually wired from qi/xero.invoice.create or qi/xero.invoice.list output.',
      },
      {
        path: 'AccountID',
        portType: 'string',
        required: true,
        description:
          'UUID of the Xero bank/treasury account the payment debits. run() throws if blank; set in template/org config.',
      },
      {
        path: 'Amount',
        portType: 'number',
        required: true,
        description:
          'Payment amount; must be a positive number. run() throws if not finite or <= 0.',
      },
      {
        path: 'tenant_id',
        portType: 'string',
        description: 'Xero org identifier; empty uses the connection default.',
      },
      {
        path: 'Date',
        portType: 'string',
        description: 'Payment date (YYYY-MM-DD); defaults to today if blank.',
      },
      {
        path: 'Reference',
        portType: 'string',
        description:
          'Free-text reference, typically the on-chain tx hash for crypto payouts.',
      },
      {
        path: 'CurrencyRate',
        portType: 'number',
        description: 'Optional currency rate for multicurrency payments.',
      },
    ],
    requires: [
      {
        kind: 'connectedAccount',
        description:
          'A connected Xero account (connectedAccountId) pinned on the block — ask the user to connect Xero before running.',
      },
      {
        kind: 'invoiceId',
        description:
          'The UUID of an existing AUTHORISED invoice to pay — source from qi/xero.invoice.create / list, or ask the user.',
      },
      {
        kind: 'xeroAccountId',
        description:
          'The UUID of the Xero bank/treasury account to debit (AccountID) — org-level config; ask the user.',
      },
    ],
  },

  // ── Carbon, entity transfer & payment ─────────────────────────────────────
  'qi/carbon.loadBatches': {
    summary:
      "Read-only reconciliation of a wallet's owner-side and entity-admin-side CARBON batches into a unified harvestable/retireable view. No signing, no on-chain change; the output feeds downstream harvest/retire blocks.",
    whenToUse: [
      'An automation needs to discover which CARBON batches a wallet can harvest or retire.',
      'You need the harvestable/retireable batch lists to wire into a carbon.harvest or carbon.retire block.',
    ],
    whenNotToUse: [
      'Do NOT use to harvest or retire — this is read-only. Use carbon.harvest to claim batches or carbon.retire to burn credits.',
    ],
    tags: ['carbon'],
    inputPorts: [
      {
        path: 'ownerAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'Wallet address whose owner-side and entity-admin-side CARBON batches are reconciled. Throws if missing.',
      },
    ],
    requires: [
      {
        kind: 'ownerAddress',
        description:
          'The wallet address to reconcile — ask the user; never invent.',
      },
    ],
  },
  'qi/carbon.harvest': {
    summary:
      "User-signed on-chain harvest: claims batches held on entity admin accounts the user owns into the user's wallet by building per-entity authz-grant + exec-transfer pairs. Side-effecting; success is proven by the returned transactionHash.",
    whenToUse: [
      "An automation needs to pull claimable CARBON batches from entity admin accounts into the owner's wallet.",
      'You have harvestable batches (e.g. from carbon.loadBatches output) the user wants to claim.',
    ],
    whenNotToUse: [
      'Do NOT use to discover batches — carbon.loadBatches is the read-only lister; harvest writes on-chain.',
      'Do NOT use to retire/burn credits — use carbon.retire.',
    ],
    tags: ['carbon'],
    inputPorts: [
      {
        path: 'ownerAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'Wallet address owning the entity admin accounts to harvest from. Throws if missing.',
      },
      {
        path: 'tokens',
        portType: 'array',
        required: true,
        description:
          'Batches to harvest (wire from carbon.loadBatches output.harvestableBatches); each item requires id, entityDid, adminAddress, and claimable > 0. Throws if empty or any item is missing a field.',
      },
    ],
    requires: [
      {
        kind: 'ownerAddress',
        description:
          'The owner wallet address to harvest into — ask the user; never invent.',
      },
    ],
  },
  'qi/carbon.retire': {
    summary:
      'User-signed, IRREVERSIBLE retirement: permanently burns/offsets CARBON credits the user holds in their wallet via a single MsgRetireToken. Cannot be undone; success is proven by the returned transactionHash.',
    whenToUse: [
      'An automation needs to permanently retire (offset/burn) credits the user holds in their wallet.',
    ],
    whenNotToUse: [
      'IRREVERSIBLE — retiring burns credits permanently and cannot be undone; confirm intent before running.',
      'Do NOT use to discover batches — carbon.loadBatches is the read-only lister.',
      'Do NOT use to claim batches from entity admin accounts — use carbon.harvest.',
    ],
    tags: ['carbon'],
    inputPorts: [
      {
        path: 'owner',
        portType: 'chainAddress',
        required: true,
        description:
          'Wallet address holding the credits to retire. Throws if missing.',
      },
      {
        path: 'tokens',
        portType: 'array',
        required: true,
        description:
          'Batches to retire (wire from carbon.loadBatches output.retireableBatches); each item requires id and amount > 0. Throws if empty or any item lacks an amount.',
      },
      {
        path: 'reason',
        portType: 'string',
        description: 'Retirement reason; defaults to "offset" when omitted.',
      },
      {
        path: 'jurisdiction',
        portType: 'string',
        description:
          'Retirement jurisdiction; defaults to "Global" when omitted.',
      },
    ],
    requires: [
      {
        kind: 'owner',
        description:
          'The owner wallet address holding the credits to retire — ask the user; never invent.',
      },
    ],
  },
  'qi/entity.transfer': {
    summary:
      'User-signed, IRREVERSIBLE transfer of an entity (domain) ownership to a new owner DID via a single MsgTransferEntity; the host resolves group recipients to their DAO controller and ensures the recipient has an IID document. Cannot be undone; success is proven by the returned transactionHash.',
    whenToUse: [
      'An automation needs to hand over ownership of a domain/entity to another user or DAO controller.',
    ],
    whenNotToUse: [
      'IRREVERSIBLE — transferring permanently reassigns domain ownership and cannot be undone; confirm both the entity and the recipient before running.',
    ],
    tags: ['entity', 'transfer'],
    inputPorts: [
      {
        path: 'entityDid',
        portType: 'entityDid',
        required: true,
        description:
          'Entity DID being transferred (did:ixo:entity:…). Throws if missing.',
      },
      {
        path: 'recipientDid',
        portType: 'did',
        required: true,
        description:
          'New owner DID (a user DID or a did:ixo:wasm: controller). Throws if missing.',
      },
      {
        path: 'ownerDid',
        portType: 'did',
        description:
          'Current owner DID; host defaults to the connected user when omitted.',
      },
      {
        path: 'ownerAddress',
        portType: 'chainAddress',
        description:
          'Current owner address; host defaults to the connected user when omitted.',
      },
    ],
    requires: [
      {
        kind: 'entityDid',
        description:
          'The entity/domain DID to transfer — ask the user; never invent.',
      },
      {
        kind: 'recipientDid',
        description:
          'The new owner DID to transfer ownership to — ask the user; never invent.',
      },
    ],
  },
  'qi/payment.execute': {
    summary:
      'Drives the payment worklist by sending a structured prompt to the companion oracle, which proposes, executes, or checks payouts for selected rows via the worker batch routes and writes results back to the block. The "execute" verb triggers real payouts (side-effecting); "propose" and "check" do not move funds.',
    whenToUse: [
      'An automation needs to propose, execute, or check status of payout rows in a payment block via the companion oracle.',
    ],
    whenNotToUse: [
      'The "execute" verb disburses real funds — confirm the proposed rows before executing.',
    ],
    tags: ['payment'],
    inputPorts: [
      {
        path: 'rowIds',
        portType: 'array',
        required: true,
        description:
          'IDs of the rows in the payment block to operate on (at least one). Throws if empty.',
      },
      {
        path: 'verb',
        portType: 'string',
        required: true,
        description:
          'Which worker route to hit: "propose", "execute", or "check". Throws if missing or not one of these.',
      },
      {
        path: 'paymentBlockId',
        portType: 'string',
        required: true,
        description:
          'The payment block ID so the oracle can edit_block results back into the right place. Throws if missing.',
      },
      {
        path: 'delegationCid',
        portType: 'string',
        description: "Optional user's UCAN delegation CID to the oracle.",
      },
      {
        path: 'skill',
        portType: 'object',
        description: 'Optional skill context with cid and name.',
      },
    ],
    requires: [
      {
        kind: 'paymentBlock',
        description:
          'A payment block holding the payout rows (worker URL, sender, defaults live in its props) — ask the user; never invent.',
      },
    ],
  },

  // ── Governance, protocol, domain & human-interaction ──────────────────────
  'qi/proposal.create': {
    summary:
      'Creates a new DAO governance proposal on-chain in the named DAO (resolves pre-proposal/group/proposal module addresses from the DAO core address, then submits the proposal with optional executable actions). On-chain side effect; requires confirmation.',
    whenToUse: [
      'A flow needs to submit a new governance proposal to a DAO for members to vote on.',
      'You want to put a set of executable on-chain actions up for DAO approval.',
    ],
    whenNotToUse: [
      'Use qi/proposal.vote to cast a vote on an EXISTING proposal — this action creates a new proposal, it does not vote.',
    ],
    tags: ['governance', 'proposals', 'dao'],
    inputPorts: [
      {
        path: 'coreAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'The DAO core contract address that owns the proposal. Usually a known/configured DAO address.',
      },
      {
        path: 'title',
        portType: 'string',
        required: true,
        description: 'The proposal title.',
      },
      {
        path: 'description',
        portType: 'string',
        required: true,
        description: 'The proposal description / body.',
      },
      {
        path: 'actions',
        portType: 'array',
        description:
          'Optional executable proposal actions; array of action objects or a JSON-string array.',
      },
    ],
    requires: [
      {
        kind: 'daoCoreAddress',
        description:
          'The target DAO core contract address (coreAddress). Ask which DAO/group the proposal is for if not provided.',
      },
    ],
  },
  'qi/proposal.vote': {
    summary:
      'Casts a vote (yes, no, no_with_veto, or abstain) on an existing DAO proposal via its proposal module contract, with an optional rationale. On-chain side effect; requires confirmation.',
    whenToUse: [
      'A flow needs to vote on a proposal that already exists on-chain.',
      'You want to record yes/no/abstain/no_with_veto with an optional rationale.',
    ],
    whenNotToUse: [
      'Use qi/proposal.create to submit a NEW proposal — this action only votes on one that already exists.',
    ],
    tags: ['governance', 'proposals', 'voting', 'dao'],
    inputPorts: [
      {
        path: 'proposalId',
        portType: 'proposalId',
        required: true,
        description:
          'The proposal number to vote on. Typically wired from a proposal.create output.',
      },
      {
        path: 'vote',
        portType: 'string',
        required: true,
        description:
          'The vote to cast; must be one of: yes, no, no_with_veto, abstain.',
      },
      {
        path: 'proposalContractAddress',
        portType: 'chainAddress',
        required: true,
        description:
          'The proposal module contract address. Typically wired from a proposal.create output (proposalContractAddress).',
      },
      {
        path: 'rationale',
        portType: 'string',
        description: 'Optional rationale recorded with the vote.',
      },
    ],
    requires: [
      {
        kind: 'proposalId',
        description:
          'An existing proposal id and its proposal module contract address. Ask which proposal to vote on if not wired from an upstream proposal.create.',
      },
    ],
  },
  'qi/protocol.select': {
    summary:
      'Records a user/agent selection of a protocol (by DID) and echoes the chosen DID, name, and type forward as outputs. No side effect — pure passthrough used to capture a protocol choice for downstream steps.',
    whenToUse: [
      'A flow needs to capture which protocol/template was chosen and pass it downstream.',
      'You want a selected protocol DID available as a typed output for later blocks.',
    ],
    tags: ['protocol', 'selection'],
    inputPorts: [
      {
        path: 'selectedProtocolDid',
        portType: 'did',
        required: true,
        description: 'DID of the protocol to select.',
      },
      {
        path: 'selectedProtocolName',
        portType: 'string',
        description: 'Optional display name of the selected protocol.',
      },
      {
        path: 'selectedProtocolType',
        portType: 'string',
        description: 'Optional type of the selected protocol.',
      },
    ],
    requires: [
      {
        kind: 'protocol',
        description:
          'A protocol DID to select. Ask which protocol/template if not provided upstream.',
      },
    ],
  },
  'qi/domain.sign': {
    summary:
      'Creates a domain entity (e.g. DAO/pod) on-chain: optionally creates a governance group, creates the domain, then signs a Domain Card verifiable credential (PIN-gated), uploads it, attaches it as a linked resource, optionally links the new entity to a parent, sources its Matrix spaces, and imports selected protocol templates. Multi-step on-chain side effect; resumable via checkpoint; requires confirmation.',
    whenToUse: [
      'A flow needs to mint a new domain/POD entity on-chain from an approved domain card.',
      'You want to create a governed entity (with a governance group) and attach a signed Domain Card credential.',
    ],
    whenNotToUse: [
      'Use qi/domain.card-preview to show/approve the card before signing — this action performs the irreversible on-chain creation and credential signing.',
    ],
    tags: ['domain', 'credentials', 'entity', 'on-chain', 'signing'],
    inputPorts: [
      {
        path: 'domainCardData',
        portType: 'object',
        required: true,
        description:
          'Domain card envelope (object or JSON string) with credentialSubject.name; signed and used to create the domain. Typically wired from domain.card-preview output.',
      },
      {
        path: 'entityType',
        portType: 'string',
        description:
          'Optional on-chain entity type; defaults from the credential type or dao/pod.',
      },
      {
        path: 'governanceConfig',
        portType: 'object',
        description:
          'Optional governance group config (object or JSON string); when present a governance group is created and linked.',
      },
      {
        path: 'memberConfig',
        portType: 'object',
        description:
          'Optional member config (object or JSON string) for the governance group.',
      },
      {
        path: 'flowTemplateConfig',
        portType: 'object',
        description:
          'Optional flow template config with selected protocol templates to import into the new domain.',
      },
      {
        path: 'context',
        portType: 'array',
        description:
          'Optional context entries (array of { key, val } or JSON string) attached to the domain.',
      },
      {
        path: 'selectedEntityDid',
        portType: 'entityDid',
        description:
          'Optional parent entity DID to link the new POD to (alternates: parentDid, parentDID).',
      },
    ],
  },
  'qi/domain.card-preview': {
    summary:
      'Validates and approves an oracle-enriched Domain Card preview (checks credentialSubject.name), then echoes the approved domainCardData forward and emits an "approved" event. No on-chain side effect — a human-approval gate between card build and signing.',
    whenToUse: [
      'A flow needs a human to review/approve a domain card before it is signed and created on-chain.',
      'You want to pass approved domainCardData forward to qi/domain.sign.',
    ],
    whenNotToUse: [
      'Use qi/domain.sign to actually create the domain and sign the credential — this action only previews and approves, it makes no on-chain changes.',
    ],
    tags: ['domain', 'credentials', 'preview', 'approval'],
    inputPorts: [
      {
        path: 'domainCardData',
        portType: 'object',
        required: true,
        description:
          'Domain card envelope (object or JSON string) with credentialSubject.name; echoed forward for signing.',
      },
      {
        path: 'domainPreviewData',
        portType: 'object',
        description:
          'Optional oracle-enriched human-facing preview of the domain card (object or JSON string).',
      },
    ],
  },
  'qi/form.submit': {
    summary:
      "Human-interaction step that captures a person's form answers and emits them both as a JSON string (form.answers, matching the form block runtime) and as a parsed object. Gathers input from a user — not background automation.",
    whenToUse: [
      'A flow needs to collect structured answers from a person via a form.',
      'You want submitted form answers available downstream as JSON and as an object.',
    ],
    whenNotToUse: [
      'Use qi/human.checkbox.set for a single yes/no acknowledgement — this action captures a full set of form answers.',
    ],
    tags: ['human', 'form', 'input'],
    inputPorts: [
      {
        path: 'answers',
        portType: 'object',
        description:
          'Form answers as an object or JSON-string object (also read from form.answers). Normally supplied by the person filling the form.',
      },
    ],
    requires: [
      {
        kind: 'formSchema',
        description:
          'A form definition/schema describing the fields the person fills in. Ask what the form should collect if not provided.',
      },
    ],
  },
  'qi/human.form.submit': {
    summary:
      "Backward-compatible alias of qi/form.submit. Human-interaction step that captures a person's form answers and emits them as a JSON string (form.answers) and a parsed object. Gathers input from a user — not background automation.",
    whenToUse: [
      'An existing/saved flow references the legacy human.form.submit type and needs a person to submit form answers.',
    ],
    whenNotToUse: [
      'For new flows prefer the canonical qi/form.submit; use qi/human.checkbox.set for a single acknowledgement rather than a full form.',
    ],
    tags: ['human', 'form', 'input'],
    inputPorts: [
      {
        path: 'answers',
        portType: 'object',
        description:
          'Form answers as an object or JSON-string object (also read from form.answers). Normally supplied by the person filling the form.',
      },
    ],
    requires: [
      {
        kind: 'formSchema',
        description:
          'A form definition/schema describing the fields the person fills in. Ask what the form should collect if not provided.',
      },
    ],
  },
  'qi/human.checkbox.set': {
    summary:
      'Human-interaction step representing a checkbox a person ticks; emits checked (defaults to true when executed). Gathers a single boolean acknowledgement from a user — not background automation.',
    whenToUse: [
      'A flow needs a person to acknowledge/confirm a single item before continuing.',
      'You want a simple checked=true/false gate driven by a human.',
    ],
    whenNotToUse: [
      'Use qi/form.submit when you need to collect multiple structured answers — this action only records a single checkbox state.',
    ],
    tags: ['human', 'checkbox', 'input'],
    inputPorts: [
      {
        path: 'checked',
        portType: 'boolean',
        description:
          'Whether the checkbox should be checked; defaults to true when the step executes.',
      },
    ],
  },
};
