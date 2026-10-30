# Local raffle time-zone labels

The Bi-Weekly and 50/50 headers display sales-start, sales-cutoff, and draw times
in the viewer's own browser/desktop time zone. Different viewers can see different
clock times for the same instant. The schedule itself remains Eastern time.

Each of the three timestamps includes its own local-zone label for that date.
For example, a Central-time period crossing fall-back can start with **CDT** and
end with **CST**. Spring-forward can start with **CST** and end with **CDT**.
Eastern viewers see EDT/EST; Pacific viewers see PDT/PST. Browsers localize the
short time-zone name and may display a GMT offset where no abbreviation exists.

This is a display-only change. The separate DST schedule correction keeps the
underlying raffle at a 7 PM Eastern cutoff and an 8 PM Eastern draw. With that
correction, a Central-time viewer sees a 6 PM cutoff and 7 PM draw, with the
appropriate CDT or CST label. Each endpoint resolves its own daylight-saving
offset; a single label for the whole period would be misleading.

Rebuild/deploy the web and desktop clients. No backend timing, environment,
database, Discord bot, or Google Apps Script change is required for these labels.
