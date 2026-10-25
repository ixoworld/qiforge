# Professional oracle observations

Workers can load a professional oracle's `x-professional-oracle` v1 profile alongside its existing observe-only domain context. Methods and rule references enter the bounded domain brief. The existing document tools and access checks control all subsequent reads. No additional document fetch is performed by observation.

Professional publication prepares immutable `persisted_draft` bytes with exact subject and IID identities and an `iid_linked_resource` intent referencing `<did>#dom`. Both self-CID and `verified_at` remain null; approval does not invent a future chain-verification timestamp. The resolver accepts this form only for the supported professional oracle profile targeting QiForge, after the existing canonical or pinned anchor, identity, static validation and CID checks. Generic drafts remain unavailable. Actual anchor evidence is recorded outside the approved bytes in publication receipts and run provenance; it establishes integrity, not adoption or constitutional compliance.

Configure `domainContext.professionalObservations` to receive advisory document-context records:

```ts
domainContext: {
  mode: 'observe',
  professionalObservations: {
    mode: 'advisory',
    emit: async (record) => {
      await observationStore.put(record.observationId, record);
    },
  },
}
```

`observationStore` is the operator's access-controlled telemetry sink. Store records idempotently by `observationId`. The runtime schedules the sink through its background facility and waits at most one second in that background task. No sink result or error changes the prompt, tools, authorization, decision, or delivery. Do not perform synchronous blocking work inside a sink. The default configuration has no observer.

The deterministic check records whether a referenced document was read. `consistent` applies to that provenance check only. It does not attest that the agent complied with the document. Unread or unavailable documents produce `insufficient_evidence`. A fallback from a requested revision records both requested and actual revisions as an `apparent_inconsistency`; the existing fallback remains available.

Records contain document CIDs and rule references, not document text, credentials, model reasoning, or raw errors. They are private operational evidence by default. Only the oracle's own professional context is observed; loading a customer's subject domain does not export its document inventory to this sink.

The only observation mode is `advisory`. No model assessment runs here, and no finding adds a review requirement, abstention, transaction restriction, or constitutional enforcement. Existing runtime and tool authorization controls continue unchanged.

The dependency-free source contract is generated from `@ixo/oracle-observations` in `ixoworld/qi-runtimes`. Its adjacent provenance file pins the source digest. Keep the generated snapshot byte-identical until the shared package is released.

Verification covers actual publisher output, opt-in behavior, unchanged prompts and tools, thrown and rejected sinks, pending sinks, revision fallback, and replay suppression through the main-agent path. Deployed cloud-client acceptance is separate from these local tests.
