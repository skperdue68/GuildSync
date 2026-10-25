# Raffle Archive Draw Delay Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan.

**Goal:** Archive automatically after raffle draw time plus configured hours.

**Architecture:** Keep the sales cutoff guard and durable pending state. Compute new automatic deadlines from drawTime; migrate unstarted legacy deadlines once while preserving their saved delay and manual archive behavior.

**Tech Stack:** Node.js, node:test.

**Spec:** User request: archive after draw/end plus configured hours, with sales cutoff guard separate.

## Global Constraints
Separate branch and PR; no Apps Script changes.

## Review Focus
Restart deadlines, manual bypass, zero delay, distinct cutoffs, shared cutoffs.

### Task 1: Correct deadline anchor
- [ ] Add a failing regression to raffle-sheet-rollover.test.js with salesEnd 100, drawTime 120 and delay 40; expect readyAt 160 and no copy at 140 or 159.
- [ ] Run node --test raffle-sheet-rollover.test.js and confirm the deadline assertion fails.
- [ ] Update createRollover pending readyAt using the latest drawTime among closing raffles plus delay.
- [ ] Adjust legacy fixtures to realistic draw times and retain Eastern date naming verification.
- [ ] Run rollover tests and full backend suite; report existing failures.
- [ ] Commit, push, create separate PR.


## Findings and compatibility
The failing regression produced readyAt 140 instead of 160 for salesEnd 100, drawTime 120, delay 40. New automatic jobs now wait for drawTime plus configured delay (the latest draw when cutoffs are shared). The sales cutoff continues to start the hold and determine period advancement; manual archive bypass remains available. Unstarted automatic pending jobs migrate once from sales cutoff plus their originally saved delay to draw plus that same delay. A durable deadlineBasis marker prevents repeated offset addition. Copied jobs, manual jobs and older jobs without readyAt retain their recovery behavior. Apps Script is unchanged.


### Task 2: Upgrade pending holds safely
- [x] Reproduce an early archive from an unmarked readyAt 140 (salesEnd 100, draw 120, saved delay 40).
- [x] Mark new automatic jobs with deadlineBasis draw; migrate only unstarted unmarked automatic holds before copying.
- [x] Persist migration before side effects and test save failure retry, repeated restarts, changed live delay, copied/undated/manual recovery and explicit manual override.
- [ ] Run focused and full backend suite, update the existing PR and push.
