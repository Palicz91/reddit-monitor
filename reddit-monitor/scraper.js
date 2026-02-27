const config = require('./config');

// ============================================================
// SCRAPER (JSON API - no Playwright needed)
// ============================================================

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function scrapeSubreddit(subreddit) {
  const url = `https://old.reddit.com/r/${subreddit}/new.json?limit=25`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (res.status !== 200) {
      console.log(`  ❌ r/${subreddit}: HTTP ${res.status}`);
      return [];
    }

    const json = await res.json();
    const posts = (json.data?.children || [])
      .filter(child => child.kind === 't3')
      .map(child => {
        const d = child.data;
        return {
          title: d.title || '',
          selftext: d.selftext || '',
          url: d.url || '',
          permalink: d.permalink || '',
          created_utc: d.created_utc || 0,
          subreddit: d.subreddit || subreddit,
          num_comments: d.num_comments || 0,
          score: d.score || 0,
        };
      });

    const withBody = posts.filter(p => p.selftext.trim().length > 0).length;
    console.log(`  ✅ r/${subreddit}: ${posts.length} posts (${withBody} with body)`);
    return posts;
  } catch (err) {
    console.log(`  ❌ r/${subreddit}: ${err.message}`);
    return [];
  }
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  const startTime = Date.now();
  console.log(`\n🚀 Reddit Scraper - ${new Date().toISOString()}`);
  console.log(`📋 ${config.subreddits.length} subreddits, last ${config.hoursAgo}h\n`);

  // Step 0: Check daily limit before scraping
  try {
    const baseUrl = config.supabaseUrl.split('?')[0];
    const checkRes = await fetch(baseUrl, {
      headers: { 'Authorization': `Bearer ${config.supabaseAuthToken}` },
    });
    const status = await checkRes.json();
    if (status.slotsLeft <= 0) {
      console.log(`⏸️ Daily limit reached (${status.draftsToday}). Skipping.`);
      return;
    }
    console.log(`📊 ${status.slotsLeft} slots left today\n`);
  } catch (e) {
    console.log('⚠️ Could not check daily limit, proceeding anyway\n');
  }

  // Step 1: Scrape all subreddits
  let allPosts = [];
  for (const sub of config.subreddits) {
    const posts = await scrapeSubreddit(sub);
    allPosts.push(...posts);

    // Polite delay between subreddits
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  }

  // Step 2: Filter recent posts
  const cutoff = Date.now() / 1000 - config.hoursAgo * 3600;
  const recentPosts = allPosts.filter(p => p.created_utc > cutoff);

  // Step 3: Deduplicate
  const seen = new Set();
  const uniquePosts = recentPosts.filter(p => {
    const key = p.permalink || p.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 4: Filter out posts without body text
  const postsWithBody = uniquePosts.filter(p => p.selftext.trim().length > 0);
  const skipped = uniquePosts.length - postsWithBody.length;

  console.log(`\n📊 Summary:`);
  console.log(`   Total scraped: ${allPosts.length}`);
  console.log(`   Recent (${config.hoursAgo}h): ${recentPosts.length}`);
  console.log(`   Unique: ${uniquePosts.length}`);
  console.log(`   Skipped (no body): ${skipped}`);
  console.log(`   Sending to score: ${postsWithBody.length}`);
  console.log(`   Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  if (postsWithBody.length === 0) {
    console.log('\n📭 No recent posts with body text to send.');
    return;
  }

  // Step 5: Send to Supabase with config
  console.log(`\n📤 Sending ${postsWithBody.length} posts to Supabase...`);
  try {
    const res = await fetch(config.supabaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabaseAuthToken}`,
      },
      body: JSON.stringify({
        source: 'json-scraper',
        posts: postsWithBody,
        keywords: config.keywords,
        scorePrompt: config.scorePrompt,
        draftPrompt: config.draftPrompt,
        dailyDraftLimit: config.dailyDraftLimit,
        maxPerRun: config.maxPerRun,
        minScore: config.minScore,
      }),
    });
    const data = await res.json();
    console.log(`📬 Response:`, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Supabase POST failed:', err.message);
  }

  console.log(`\n✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
})();
