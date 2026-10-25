# Rolling Raffle Spending Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved task.

**Goal:** Show raffle spending during the inclusive last 90 days through now.
**Architecture:** Filter normalized purchased-ticket banking entries using original entry.time only for the spending card and overview. Preserve current raffle ticket leader selection.
**Tech Stack:** Node.js, node:test.
**Spec:** User-approved rolling raffle spending item.

## Global Constraints
Preserve case folding, marker removal, bonus exclusion and current raffle ticket behavior.

## Review Focus
Exact cutoff included; future and older records excluded; stale totals expire without new purchases; mixed-case accounts combine; bonus-only entries excluded.

### Task 1: Rolling spending
Files: community-statistics.js and community-statistics.test.js.
- [x] Add boundary, expiry, normalization and current-raffle regression assertions; observe failure.
- [x] Filter purchases by entry.time >= now - 90*86400 for spending and label period.
- [ ] Run focused and full backend tests; commit independent item.
