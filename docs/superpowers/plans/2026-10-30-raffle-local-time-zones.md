# Label local raffle times

User requests local-zone labels for both Bi-Weekly and 50/50 sales starts, sales
cutoffs, and draw times. Display each timestamp with the viewer's zone name at
that timestamp, so a DST-crossing period can show CDT at its start and CST at its
end. Keep the display in the viewer's own zone; do not force Eastern in the UI.

Add an opt-in time-zone flag to the existing banking timestamp formatter and
enable it only at the three raffle-header timestamps in each client. Preserve
the existing ordinary banking-row timestamp display. Add red/green real-function
VM tests for Eastern/Central/Pacific, both DST directions, both raffle types, and
invalid timestamps. Build both clients and submit a separate display-only PR.
