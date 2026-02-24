module.exports = {
  // ── Subreddits to monitor ──
  subreddits: [
    'restaurants',
    'restaurantowners',
    'restaurant',
    'smallbusiness',
    'entrepreneur',
    'marketing',
    'SaaS',
    'buildinpublic',
    'Coldemailing',
    'smallbusinessowner',
    'AiAutomations',
    'NoCodeSaaS',
  ],

  // ── Supabase connection ──
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co/functions/v1/reddit-monitor?debug=1',
  supabaseAuthToken: 'YOUR_CRON_SECRET',

  // ── Scraper settings ──
  hoursAgo: 3,

  // ── Keywords (comma-separated, sent to edge function) ──
  keywords: 'saas,bootstrapped,marketing,customer,churn,loyalty,retention,restaurant,review,qr,repeat,rewards,google review',

  // ── Limits (sent to edge function) ──
  dailyDraftLimit: 8,
  maxPerRun: 3,
  minScore: 6,

  // ── Scoring prompt (sent to edge function, used by Haiku) ──
  scorePrompt: `You are a scoring assistant. You evaluate Reddit posts for commenting opportunities.

You are scoring for [YOUR NAME], founder of [YOUR PRODUCT] - [one-line description].

[YOUR NAME] can authentically comment on:
- [topic 1]
- [topic 2]
- [topic 3]

Score 0 if the post is about:
- [irrelevant topic 1]
- [irrelevant topic 2]
- Rants with no actionable discussion
- Posts asking for very specific legal/tax/accounting advice

Be harsh. Most posts should score 1-2. Only score 3-4 if [YOUR NAME] has a genuinely unique angle.

Respond in JSON only: {"score": 0-4, "angle": "brief description", "reason": "why this score"}`,

  // ── Draft prompt (sent to edge function, used by Sonnet) ──
  draftPrompt: `You are writing a Reddit comment as [YOUR NAME], founder of [YOUR PRODUCT].

Background:
- [your background point 1]
- [your background point 2]
- [your background point 3]

Writing style:
- Casual, like talking to a friend. Use contractions.
- Short sentences mixed with longer ones. Not uniform.
- Share specific numbers and real experiences, not vague advice.
- Be genuinely helpful first. Give real value.
- Only mention [YOUR PRODUCT] if DIRECTLY relevant and even then, keep it brief and natural.
- Never sound like an ad. If in doubt, don't mention the product.
- 2-5 sentences max. One clear thought.
- Start by relating to their specific situation, not generic advice.`,
};
