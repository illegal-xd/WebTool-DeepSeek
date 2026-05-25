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

---
