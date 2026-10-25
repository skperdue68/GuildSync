# Raffle Sales Reminder Verification Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan.

**Goal:** Verify sales reminders count back from ticket sales cutoff.
**Architecture:** Trace live configuration and runtime scheduling; add verification tests where production behavior is already correct.
**Tech Stack:** Node.js, node:test.
**Spec:** Reported two-hour warning arrived one hour before sales closed.

## Global Constraints
Separate branch and PR; no Apps Script changes; do not infer deployed values from defaults.

## Review Focus
Sales versus draw, both raffle types, restart deduplication, live override precedence, late startup.

### Task 1: Verify cutoff anchor
- [ ] Trace environment/defaults and live overrides into scheduler and formatter.
- [ ] Add tests: cutoff 20000, draw 23600, lead 2 means first warning 12800, no duplicate 16400.
- [ ] Verify override 1 supersedes baseline 2 and deleting restores 2.
- [ ] Reproduce late startup at 16400 delivering the still valid warning.
- [ ] Run full bot suite; document findings, commit, push and create PR.
