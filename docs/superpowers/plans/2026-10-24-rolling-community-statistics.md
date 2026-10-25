# Rolling Discord Statistics Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved task.

**Goal:** Rank Discord activity over the inclusive last 30 days through now.
**Architecture:** Bound persisted event timestamps in SQL and defensively filter report inputs; retain all event history and separate activity coverage metadata.
**Tech Stack:** Node.js, MySQL, node:test.
**Spec:** User-approved rolling Discord statistics item.

## Global Constraints
Preserve historical events; exclude future records; keep tracking start independent from the reporting window.

## Review Focus
Exact cutoff and now included; older and future records excluded; stale leaders expire without new writes; command telemetry remains excluded; coverage metadata persists.

### Task 1: Rolling reporting
Files: community-statistics.js and community-statistics.test.js.
- [x] Write boundary/expiry and bounded-query tests and observe failures.
- [x] Filter original timestamps with now - 30*86400 <= timestamp <= now; label the report period.
- [ ] Run focused and full backend tests; commit the independent item.
