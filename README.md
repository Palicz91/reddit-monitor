# Reddit Comment Monitor

AI-powered system that monitors Reddit, finds posts worth commenting on, generates draft comments, and delivers them to Telegram. ~$2/month.

## How it works

```
Your Laptop (Playwright)  →  Supabase Edge Function  →  Telegram
     scrapes Reddit             scores + drafts            you get notified
```

1. **Scraper** runs on your laptop every 3 hours (cron)
2. Scrapes new posts from your chosen subreddits
3. Sends posts to Supabase Edge Function
4. Edge Function filters by keywords, scores with AI, generates draft comments
5. You get a Telegram message with the post + draft comment to copy/paste

## What you need

- A laptop (Mac/Linux/Windows)
- Node.js installed
- A Supabase account (free)
- A Telegram account
- An Anthropic API key (~$2/month usage)

## Setup (15 minutes)

### Step 1: Clone and install

```bash
git clone <this-repo>
cd reddit-monitor
npm install
npx playwright install chromium
```

### Step 2: Create a Telegram bot

1. Open Telegram, search for `@BotFather`
2. Send `/newbot`
3. Choose a name (e.g. "My Reddit Monitor")
4. Choose a username (e.g. "myredditmonitor_bot")
5. Copy the **bot token** (looks like `123456:ABC-DEF...`)
6. Send a message to your new bot
7. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
8. Find your `chat_id` in the response (a number like `123456789`)

Save both the **bot token** and **chat id**.

### Step 3: Get an Anthropic API key

1. Go to https://console.anthropic.com
2. Create an account / sign in
3. Go to API Keys → Create Key
4. Copy the key (starts with `sk-ant-...`)

### Step 4: Set up Supabase

1. Go to https://supabase.com → New Project
2. Choose a name, set a password, pick a region close to you
3. Wait for the project to be created

**Create the database tables:**
1. Go to SQL Editor (left sidebar)
2. Paste the contents of `setup.sql` and click Run

**Deploy the Edge Function:**
1. Install the Supabase CLI: https://supabase.com/docs/guides/cli
2. Link your project:
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```
3. Deploy:
```bash
supabase functions deploy reddit-monitor
```

**Set environment variables:**

Go to Supabase Dashboard → Edge Functions → reddit-monitor → Secrets, and add:

| Key | Value |
|---|---|
| `REDDIT_MONITOR_TG_TOKEN` | Your Telegram bot token |
| `REDDIT_MONITOR_TG_CHAT_ID` | Your Telegram chat id |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (sk-ant-...) |
| `REDDIT_MONITOR_CRON_SECRET` | A random string (same as `supabaseAuthToken` in config.js) |
| `KEYWORDS` | Comma-separated keywords, e.g. `saas,bootstrapped,marketing,customer,churn` |
| `SCORE_PROMPT` | Your scoring prompt (see config.js for template) |
| `DRAFT_PROMPT` | Your draft prompt (see config.js for template) |
| `DAILY_DRAFT_LIMIT` | `8` (or whatever you want) |
| `MAX_PER_RUN` | `3` |
| `MIN_SCORE` | `6` |

### Step 5: Configure your settings

Edit `config.js`:

1. **subreddits** - Add the subreddits you want to monitor
2. **keywords** - Add keywords that match posts relevant to you
3. **supabaseUrl** - Your Supabase function URL (`https://YOUR_PROJECT.supabase.co/functions/v1/reddit-monitor?debug=1`)
4. **supabaseAuthToken** - Same random string you set as `REDDIT_MONITOR_CRON_SECRET`
5. **scorePrompt** - Describe YOUR persona, expertise, and angles
6. **draftPrompt** - Describe YOUR writing style and product mention rules

### Step 6: Test

```bash
node scraper.js
```

You should see posts being scraped and a response from Supabase. Check Telegram for draft messages.

### Step 7: Set up cron

Run every 3 hours while your laptop is open:

**Mac/Linux:**
```bash
# Check your node path first
which node

# Set up cron (replace /usr/local/bin/node with your path)
echo "0 8,11,14,17,20,23 * * * cd ~/reddit-monitor && /usr/local/bin/node scraper.js >> ~/reddit-monitor.log 2>&1" | crontab -

# Verify
crontab -l
```

**Windows (Task Scheduler):**
1. Open Task Scheduler
2. Create Basic Task → name it "Reddit Monitor"
3. Trigger: Daily, repeat every 3 hours
4. Action: Start a program → `node`, arguments: `scraper.js`, start in: `C:\path\to\reddit-monitor`

## Customizing the AI

The two most important things to customize are the **scoring prompt** and **draft prompt**.

### Scoring prompt

This tells the AI who you are and what posts are relevant. Be specific about:
- Your expertise and unique angles
- What topics you have NOTHING to say about (score 0)
- Tell it to be harsh. Most posts should score low.

### Draft prompt

This controls the voice of your comments. Include:
- Your background and what you can authentically share
- Your writing style (casual? formal? short? long?)
- Rules for when to mention your product (if ever)
- Specific data points or stories the AI can reference

## Costs

| Component | Monthly cost |
|---|---|
| Reddit scraping | $0 (your laptop) |
| Supabase | $0 (free tier) |
| Claude Haiku (scoring) | ~$0.30 |
| Claude Sonnet (drafts) | ~$1.50 |
| Telegram | $0 |
| **Total** | **~$2/month** |

## FAQ

**Does this need my Reddit login?**
No. It scrapes old.reddit.com without authentication from your residential IP.

**What if my laptop is closed?**
The cron job won't run. No posts are lost, you just don't get drafts for that period. It picks back up when you open your laptop.

**Can I change subreddits/keywords without redeploying?**
Subreddits and hours: edit `config.js` locally, no deploy needed.
Keywords and prompts: update the env vars in Supabase dashboard, no deploy needed.

**What if Reddit blocks me?**
Unlikely with residential IP and polite rate limiting (2-4 second delays). If it happens, the scraper logs 403 errors and skips that subreddit.

**Can I use this for multiple people?**
Each person needs their own Supabase project and config. The edge function code is the same.

## File structure

```
reddit-monitor/
├── config.js          ← YOUR settings (subreddits, prompts, etc)
├── scraper.js         ← Runs on your laptop (cron)
├── setup.sql          ← Database tables (run once)
├── package.json
├── README.md
└── supabase/
    └── functions/
        └── reddit-monitor/
            └── index.ts  ← Edge function (deploy to Supabase)
```
