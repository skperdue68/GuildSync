# Membership statistics ordering

User clarified that apparent duplication meant two join/leave categories, not
duplicate counts. Approved resolution: keep ESO guild joins and Discord server
joins with unmistakable source labels, remove both leave rankings, and place the
two join cards after all other highlights. Do not alter ingestion, history,
membership records, join filters, or event counts.

Add regression checks for exactly two membership cards, source-specific labels,
join totals, and their final ordering. Change backend report assembly only,
document the presentation, verify tests, and submit one independent PR.
