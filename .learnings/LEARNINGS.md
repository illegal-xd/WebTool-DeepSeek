# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260525-003] correction

**Logged**: 2026-05-25T00:00:00Z
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
DeepSeek cached conversation rendering needs route-window-specific tool card restoration.

### Details
When DeepSeek renders a switched conversation from its own cache without calling the history API, assistant messages can arrive asynchronously after the pathname changes. Restoring persisted tool cards immediately can run against unstable DOM, while restoring on every assistant insertion recreates duplicate cards during normal new replies.

### Suggested Action
For cached route switches, allow assistant-node-triggered restore only inside a short route restore window, delay assistant-index fallback for persisted records, and suppress transient “执行中” placeholders while stripping cached raw tool markup.

### Metadata
- Source: user_feedback
- Related Files: entrypoints/content.ts
- Tags: tool-cards, cached-render, route-restore, duplicate-render

---

## [LRN-20260525-002] correction

**Logged**: 2026-05-25T00:00:00Z
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Tool card restore must not run on every assistant DOM insertion.

### Details
Triggering `restorePersistedToolBlocks` from the DOM observer whenever an assistant message node is added causes persisted historical tool cards to be replayed during normal new replies. With assistant-index fallback enabled, this can attach old tool call cards to later assistant messages and recreate duplicate rendering.

### Suggested Action
Limit tool card restoration to page init, explicit history restore, and route changes. Use DOM observer only to detect route changes and clean raw tool markup, not to replay persisted cards for ordinary assistant-message mutations.

### Metadata
- Source: user_feedback
- Related Files: entrypoints/content.ts
- Tags: tool-cards, duplicate-render, dom-observer

---

## [LRN-20260525-001] correction

**Logged**: 2026-05-25T00:00:00Z
**Priority**: medium
**Status**: pending
**Area**: frontend

### Summary
Tool card restore fixes must cover both immediate history restore and route-switch persisted restore paths.

### Details
A fix that enabled safe assistant-index fallback only for `RESTORE_TOOL_CALLS` restored initial history rendering but missed the case where the user switches away from a conversation and then back. That path uses `restorePersistedToolBlocks`, so it also needs the same controlled fallback while still avoiding the old broad “first available message” reuse behavior.

### Suggested Action
When changing tool card rendering, test both fresh history load and route-switch return flows.

### Metadata
- Source: user_feedback
- Related Files: entrypoints/content.ts
- Tags: tool-cards, route-restore, history-restore

---
