---
'@ixo/oracle-runtime-workers': patch
---

A tool that throws inside a sub-agent no longer ends the sub-agent. Its error
becomes the call's result (an error `ToolMessage`), so the sub-agent can try
another source or answer from what it already has; the main agent already
worked this way. Before, one failed fetch (an MCP tool's `isError`, e.g. a site
that answers Firecrawl's scrape with a 403) threw the whole Firecrawl Agent away,
its good searches included, and the parent read "Web search is unavailable".

- New `createToolErrorResultMiddleware` (LangChain's `toolErrorMiddleware` with
  the runtime's rules), the outermost tool layer of every sub-agent dispatch,
  right after the dangling-call repair. It still lets through an aborted turn, a
  turn out of budget, and LangGraph interrupts / drains / parent commands. A
  schema rejection reads `Invalid arguments for <tool>: <reason>`, as on the
  main agent, now without the inner error's stack. All tools are covered,
  writes too: a write whose failure leaves its outcome unknown says so in its
  result and keeps its run-ledger claim, and the repetition guard refuses the
  identical failed call. Sub-agents get their inner tools' effects from the main
  agent for this.
- Forwarded sub-agent calls keep their error status in the parent's history.
- The tool-execution middleware logs a warning whenever a tool throws, and a
  sub-agent that fails logs one too (both were silent). Error log lines are
  capped at 300 characters, and a schema rejection is logged without its
  arguments.
- The Firecrawl Agent's failure hint no longer says web search is unavailable;
  its prompt says how to carry on after one page fails.
