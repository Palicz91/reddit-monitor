# Reddit monitor (laptop scraper)

Finds Reddit posts where business owners ask how to get a negative, fake or unfair
Google review removed, and sends them to Telegram with a suggested reply.

Reddit blocks its JSON endpoints from datacenter IPs (servers get HTTP 403), so the
fetching runs on a Mac with a home connection. Everything else (which posts matter,
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
./install-mac.sh run        # one test run in the terminal
./install-mac.sh            # install: runs every 3 hours, catches up after sleep
```

- Log: `tail -f ~/Library/Logs/reddit-monitor.log`
- Remove: `./install-mac.sh uninstall`
- Tests: `npm test`

The Mac must be awake and online for a run. The backend looks back 36 hours, so a laptop
that sleeps overnight still catches everything when it wakes. Posts are never sent twice.

## Changing what is searched

Search phrases and subreddits live in the backend (`supabase/functions/reddit-monitor/logic.ts`
in the ReviewTactic repo). The list in `scraper.mjs` is only used when the backend can't be reached.
