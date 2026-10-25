# Local statistics dates and clear count labels

Approved saved request: display membership timestamps in the viewer's local time,
and explain what statistic units mean. Keep stored/server timestamps in UTC.
Format ISO timestamps inside row details at render time using the browser locale
and time zone, including a short zone name. Preserve ordinary detail text and
escape all output. Use descriptive join/departure/post/reaction units and correct
singular day labels; explain that posts/reactions differ from clicks/commands.

Add failing UI tests for local formatting, invalid dates, escaping, and units.
Update both mirrored components, run tests and client builds, document behavior,
and submit this item independently from rolling-window and category changes.
