# Reading community statistics

Membership row timestamps, report update times, and tracking start times display
in the viewer's browser/desktop local time zone, with a short zone name. Server
and database timestamps remain unchanged. Formatting happens when results render.

- A **join** is a recorded membership join for the source named on that card.
- A **departure** is a recorded leave or kick.
- A **post** is a new Discord message from a person, excluding bots/system posts.
- A **reaction** is an emoji added to a Discord message, including a like.
- **Posts + reactions** is the combined Discord activity count. It does not
  include button clicks or slash-command usage.
- **Days** measures the time since a current ESO member's latest recorded join.
  Import timestamps are not treated as verified membership dates.

Deploy/rebuild the web and desktop clients for these display changes. No database,
bot, Google Apps Script, or environment setting change is needed.
