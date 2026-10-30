# Raffle times and daylight saving

Raffles follow the **America/New_York** calendar. Ticket sales close at **7 PM
Eastern** and draws occur at **8 PM Eastern**, in both daylight and standard time.
The biweekly dates keep the established June 6, 2026 cadence. The 50/50 draw is
the last scheduled biweekly draw in each Eastern calendar month.

| Draw date | Ticket cutoff | Draw | Draw timestamp in UTC |
| --- | --- | --- | --- |
| October 24, 2026 | 7 PM EDT | 8 PM EDT | October 25, 00:00 UTC |
| November 7, 2026 | 7 PM EST | 8 PM EST | November 8, 01:00 UTC |
| November 21, 2026 | 7 PM EST | 8 PM EST | November 22, 01:00 UTC |
| March 13, 2027 | 7 PM EST | 8 PM EST | March 14, 01:00 UTC |
| March 27, 2027 | 7 PM EDT | 8 PM EDT | March 28, 00:00 UTC |
| April 10, 2027 | 7 PM EDT | 8 PM EDT | April 11, 00:00 UTC |

The period crossing fall-back contains 337 elapsed hours; the one crossing
spring-forward contains 335. Normal biweekly periods contain 336. Each boundary
is converted to UTC separately instead of adding a fixed number of seconds.
Configured bonus/reminder/archive delay hours remain elapsed-hour durations.

The backend and both clients use identical calendar helpers for current and
historical periods. Purchase attribution, receipt dates, raffle summaries, sheet
windows, and previous/next navigation share the same cutoffs. A deposit exactly
at cutoff belongs to the closing raffle; one second later belongs to the next.
The public closing raffle remains visible until its draw time.

Saved unstarted automatic rollover jobs and armed windows are corrected before
cutoff decisions. Saved delay lengths and reconciliation keys are preserved.
Manual or already-copied recovery payloads remain unchanged; after recovery,
future armed windows use the corrected schedule. Completed archives are not
renamed or replaced. Existing saved bonus overrides keyed by the legacy UTC
cutoff still apply to their calendar raffle; a newer canonical override takes
precedence. Reset removes both aliases where applicable.

## Deployment

Deploy/restart the updated backend and rebuild/deploy the web and desktop clients.
There are no new environment settings or dependencies and **no Google Apps Script
update**. No separate database migration command is required. The Discord bot
reads the corrected Unix timestamps from the backend; `/raffle` can confirm them
after deployment. Discord renders its timestamps in each viewer's local zone,
so a Central-time viewer sees a 7 PM draw corresponding to 8 PM Eastern.

Old public messages retain their text until a fresh summary is posted. A new
public `/raffle public:true` post replaces older generated summaries through the
existing cleanup. Historical emails and completed archives are not rewritten.
