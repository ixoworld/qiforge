---
'@ixo/oracle-runtime-workers': patch
---

A tool that throws inside a sub-agent no longer ends the sub-agent. Its error
becomes the call's result (an error `ToolMessage`), so the sub-agent can try
another source or answer from what it already has; the main agent already
worked this way. Before, one failed fetch (an MCP tool's `isError`, e.g. a site
that answers Firecrawl's scrape with a 403) threw the whole Firecrawl Agent away,
its good searches included, and the parent read "Web search is unavailable".

- New `createToolErrorResultMiddleware`, outermost tool layer of every
  sub-agent dispatch (after the dangling-call repair). It still re-throws an
  aborted turn, a turn out of budget, LangGraph interrupts / drains / parent
  commands, and schema rejections (which ToolNode reports itself). All tools
  are covered, writes too: a write with an unknown outcome keeps its run-ledger
  claim, and the repetition guard refuses the identical failed call.
- The tool-execution middleware logs a warning whenever a tool throws, and a
  sub-agent that fails logs one too (both were silent).
- The Firecrawl Agent's failure hint no longer says web search is unavailable;
  its prompt says how to carry on after one page fails.
