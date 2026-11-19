# Reddit monitor (laptop scraper)

Finds Reddit posts where business owners ask how to get a negative, fake or unfair
Google review removed, and sends them to Telegram with a suggested reply.

Reddit blocks its JSON endpoints from datacenter IPs (servers get HTTP 403), so the
fetching runs on a Mac with a home connection. Since November 2026 Reddit also blocks every
logged-out read ("You've been blocked by network security"), so the scraper sends a Reddit
login cookie (see "Reddit login" below). Everything else (which posts matter,
scoring, drafts, Telegram, remembering what was already seen) runs on the ReviewTactic
backend. This repo holds no prompts and no secrets.

## How a run works

1. Asks the backend for this run's settings (search phrases, subreddits, how far back to look).
2. Fetches Reddit: one Reddit-wide search per phrase, plus the newest posts of a few subreddit groups.
   About 12 requests, spaced ~6 s apart (under Reddit's ~10 a minute). A 429 waits once and retries.
3. Skips posts that can't take a comment (locked, archived, removed, NSFW) and posts older than the window.
4. Sends the posts and a health block (request count, HTTP statuses) to the backend.
   If Reddit blocked every request, the backend sends one Telegram alert (at most every 12 h)
   instead of treating it as a quiet day.

## Setup (Mac)

Needs Node.js 18 or newer (`node --version`).

**Remove the old version first.** The 2026 version ran `~/Desktop/reddit-monitor-laptop.js` from a
schedule that is still firing (its log fills with `Cannot find module`). Find it and delete that line or job:

```bash
crontab -l | grep -n reddit                 # if found: crontab -e and delete the line
launchctl list | grep -i reddit             # if found: launchctl remove <label>, then delete its plist in ~/Library/LaunchAgents
```

```bash
git clone https://github.com/Palicz91/reddit-monitor.git
cd reddit-monitor/reddit-monitor
cp .env.example .env        # then put the secret you were given into RM_SECRET
                            # and the Reddit login into REDDIT_COOKIE (next section)
./install-mac.sh check      # one Reddit request: "Reddit OK" means the login works
./install-mac.sh run        # one test run in the terminal
./install-mac.sh            # install: runs every 3 hours, catches up after sleep
```

- Log: `tail -f ~/Library/Logs/reddit-monitor.log`
- Remove: `./install-mac.sh uninstall`
- Tests: `npm test`

The Mac must be awake and online for a run. The backend looks back 36 hours, so a laptop
that sleeps overnight still catches everything when it wakes. Posts are never sent twice.

## Reddit login

Reddit only answers logged-in requests now. The scraper reads 12 pages every 3 hours as
that account, so a spare Reddit account is safest (it never posts anything).

1. In Chrome, log in to reddit.com with the account to use.
2. Press Cmd+Option+I (Developer Tools) → **Application** tab → left side **Cookies** →
   `https://www.reddit.com`.
3. Click the row named `reddit_session`, copy its **Value** (the long text starting `eyJ`).
4. Paste it into `.env` after `REDDIT_COOKIE=`, save, and run `./install-mac.sh check`.

If `check` still says refused, copy the whole cookie line instead: Developer Tools →
**Network** tab → reload the page → click the first request → **Request Headers** →
right-click `cookie` → copy value, and paste that after `REDDIT_COOKIE=`.

The login lasts months. When it expires, runs print "Reddit no longer accepts the login"
and the backend sends its "blocked by Reddit" Telegram alert: copy a fresh value the same
way. Logging out of Reddit in that browser ends the session too, so use a browser profile
you stay logged in on. The cookie stays in `.env` on the Mac and is only sent to reddit.com.

## Changing what is searched

Search phrases and subreddits live in the backend (`supabase/functions/reddit-monitor/logic.ts`
in the ReviewTactic repo). The list in `scraper.mjs` is only used when the backend can't be reached.
