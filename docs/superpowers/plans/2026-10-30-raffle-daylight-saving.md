# Preserve raffle clock times across daylight saving

Confirmed user schedule: ticket cutoff is always 19:00 America/New_York; draw
is 20:00. Biweekly dates stay on the existing June 6, 2026 calendar cadence;
50/50 stays on the last biweekly draw of each Eastern calendar month.

Root cause: repeated 14*86400 arithmetic from summer UTC anchors preserves UTC
clock time instead of Eastern clock time. Previous-period subtraction, receipt
assignment, public summaries, sheet windows, and duplicated client calculations
all use that arithmetic. Correct calendar dates must each be converted to UTC
using their own Eastern offset. Bonus durations and the one-hour cutoff/draw gap
remain elapsed-hour durations.

1. Add failing regressions for November 7/21 fall-back and March 13/27 spring-
   forward, exact cutoff/draw assignment, and 50/50 month selection.
2. Introduce a dependency-free shared calendar schedule module and use it in the
   backend and both clients; eliminate fixed-second stepping of calendar periods.
3. Safely correct saved future/unstarted rollover windows and deadlines without
   disturbing copied archives or manual recovery. Preserve saved bonus overrides
   when their legacy cutoff key denotes the same calendar raffle.
4. Run focused/full tests, both client builds, independent review, and publish a
   single DST fix PR from an isolated GitHub checkout. No production writes.
