# Reddit monitor (laptop scraper)

Finds Reddit posts where business owners ask how to get a negative, fake or unfair
Google review removed, and sends them to Telegram with a suggested reply.

Reddit blocks servers (HTTP 403 from datacenter IPs), so the scraper runs on a Mac with a home
connection. Since November 2026 Reddit also blocks every logged-out read ("You've been blocked by
network security"), every non-browser client, and its `.json` listings even for a logged-in
browser. Normal old.reddit.com pages still load for a logged-in Chrome, so the scraper drives the
Mac's real Google Chrome (via `playwright-core`, which downloads no browser) on its own Chrome
profile that you log into once (see "Reddit login"), and reads old Reddit's search and subreddit
pages. Everything else (which posts matter,
scoring, drafts, Telegram, remembering what was already seen) runs on the ReviewTactic
backend. This repo holds no prompts and no secrets.

## How a run works

1. Asks the backend for this run's settings (search phrases, subreddits, how far back to look).
2. Loads old Reddit pages in Chrome (headless): one Reddit-wide search per phrase (newest first,
   past week), plus the newest posts of a few subreddit groups. About 12 pages, ~6 s apart.
   A 429 waits 30 s once and retries.
3. Skips posts that can't take a comment (locked, archived, removed, stickied, NSFW, ads) and
   posts older than the window. Then opens up to 20 posts that may be about reviews to read their
   text; texts already read come from `texts.json` next to the profile (kept 4 days).
4. Sends the posts and a health block (page count, HTTP statuses) to the backend.
   If Reddit blocked every request, the backend sends one Telegram alert (at most every 12 h)
   instead of treating it as a quiet day.

## Setup (Mac)

Needs Node.js 18 or newer (`node --version`) and Google Chrome in Applications.

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
./install-mac.sh login      # Chrome opens: log in to Reddit, then press Enter in the terminal
./install-mac.sh check      # one Reddit page: "Reddit OK" means reading works
./install-mac.sh run        # one test run in the terminal
./install-mac.sh            # install: runs every 3 hours, catches up after sleep
```

- Log: `tail -f ~/Library/Logs/reddit-monitor.log`
- Remove: `./install-mac.sh uninstall`
- Tests: `npm test`

The Mac must be awake and online for a run. The backend looks back 36 hours, so a laptop
that sleeps overnight still catches everything when it wakes. Posts are never sent twice.

## Reddit login

Reddit only answers a logged-in browser now. `./install-mac.sh login` opens Chrome on the
monitor's own profile (`~/Library/Application Support/reddit-monitor/chrome-profile`, separate
from your everyday Chrome). Log in there once; scheduled runs reuse that login in the
background, without a window. A spare Reddit account is safest: the monitor only reads,
12 pages every 3 hours.

When Reddit drops the login (password change, months later), runs print "Reddit wants a
login" and the backend sends its "blocked by Reddit" Telegram alert: run
`./install-mac.sh login` again. Close the login window before a scheduled run starts, since a
Chrome profile can only be open once.

## Changing what is searched

Search phrases and subreddits live in the backend (`supabase/functions/reddit-monitor/logic.ts`
in the ReviewTactic repo). The list in `scraper.mjs` is only used when the backend can't be reached.
