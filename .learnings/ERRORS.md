# Errors

Command failures and integration errors.

---

## [ERR-20260525-001] read_tool_pages_parameter

**Logged**: 2026-05-25T00:00:00Z
**Priority**: low
**Status**: pending
**Area**: config

### Summary
Read tool calls failed because an empty `pages` parameter was passed for a TypeScript file.

### Error
```text
Invalid pages parameter: "". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.
```

### Context
- Operation attempted: reading `entrypoints/content.ts` before editing.
- Cause: included `pages: ""` even though `pages` should be omitted for non-PDF files.

### Suggested Fix
Omit the `pages` field entirely unless reading a PDF page range.

### Metadata
- Reproducible: yes
- Related Files: entrypoints/content.ts
- Recurrence-Count: 2
- Last-Seen: 2026-05-25

---

## [ERR-20260526-001] explore_agent_api_error

**Logged**: 2026-05-26T00:00:00Z
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
Explore agent calls failed while planning prompt-flow review.

### Error
```text
API Error: 502 {"type":"error","error":{"type":"api_error","message":"unknown provider for model claude-opus-4-7"}}
```

### Context
- Operation attempted: launching Explore subagents for read-only codebase exploration.
- Fallback used: local read-only file analysis with context-mode tools.

### Suggested Fix
Use local code search or an available model override when the configured Explore agent provider is unavailable.

### Metadata
- Reproducible: unknown
- Related Files: core/interceptor/fetch-hook.ts, core/memory/injector.ts

---
