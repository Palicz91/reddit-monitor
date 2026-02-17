const { chromium } = require('playwright');
const config = require('./config');

async function scrapeSubreddit(context, subreddit) {
  const page = await context.newPage();
  const url = `https://old.reddit.com/r/${subreddit}/new/`;

  try {
    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    if (res.status() !== 200) {
      console.log(`  ❌ r/${subreddit}: HTTP ${res.status()}`);
      await page.close();
      return [];
    }

    const posts = await page.$$eval('#siteTable .thing:not(.promoted)', els =>
      els.map(el => {
        const titleEl = el.querySelector('a.title');
        const timeEl = el.querySelector('time');
        const scoreEl = el.querySelector('.score.unvoted');
        const commentsEl = el.querySelector('.comments');
        const permalink = el.getAttribute('data-permalink') || '';
        const subreddit = el.getAttribute('data-subreddit') || '';
        const expandoEl = el.querySelector('.expando .usertext-body');
        const selftext = expandoEl ? expandoEl.textContent.trim() : '';

        return {
          title: titleEl ? titleEl.textContent.trim() : '',
          selftext,
          url: titleEl ? titleEl.href : '',
          permalink,
          created_utc: timeEl ? new Date(timeEl.getAttribute('datetime')).getTime() / 1000 : 0,
          subreddit,
          num_comments: commentsEl ? parseInt(commentsEl.textContent) || 0 : 0,
          score: scoreEl ? parseInt(scoreEl.textContent) || 0 : 0,
        };
      })
    );

    console.log(`  ✅ r/${subreddit}: ${posts.length} posts`);
    await page.close();
    return posts;
  } catch (err) {
    console.log(`  ❌ r/${subreddit}: ${err.message}`);
    await page.close();
    return [];
  }
}

(async () => {
  const startTime = Date.now();
  console.log(`\n🚀 Reddit Scraper - ${new Date().toISOString()}`);
  console.log(`📋 ${config.subreddits.length} subreddits, last ${config.hoursAgo}h\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Check daily limit before scraping
  try {
    const baseUrl = config.supabaseUrl.split('?')[0];
    const checkRes = await fetch(baseUrl, {
      headers: { 'Authorization': `Bearer ${config.supabaseAuthToken}` },
    });
    const status = await checkRes.json();
    if (status.slotsLeft <= 0) {
      console.log(`⏸️ Daily limit reached (${status.draftsToday}). Skipping.`);
      await browser.close();
      return;
    }
    console.log(`📊 ${status.slotsLeft} slots left today\n`);
  } catch (e) {
    console.log('⚠️ Could not check daily limit, proceeding anyway\n');
  }

  // Scrape
  let allPosts = [];
  for (const sub of config.subreddits) {
    const posts = await scrapeSubreddit(context, sub);
    allPosts.push(...posts);
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  }
  await browser.close();

  // Filter recent
  const cutoff = Date.now() / 1000 - config.hoursAgo * 3600;
  const recentPosts = allPosts.filter(p => p.created_utc > cutoff);

  // Dedup
  const seen = new Set();
  const uniquePosts = recentPosts.filter(p => {
    const key = p.permalink || p.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📊 Summary:`);
  console.log(`   Total scraped: ${allPosts.length}`);
  console.log(`   Recent (${config.hoursAgo}h): ${recentPosts.length}`);
  console.log(`   Unique: ${uniquePosts.length}`);
  console.log(`   Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  if (uniquePosts.length === 0) {
    console.log('\n📭 No recent posts to send.');
    return;
  }

  // Send to Supabase
  console.log(`\n📤 Sending ${uniquePosts.length} posts to Supabase...`);
  try {
    const res = await fetch(config.supabaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.supabaseAuthToken}`,
      },
      body: JSON.stringify({ source: 'playwright-scraper', posts: uniquePosts }),
    });
    const data = await res.json();
    console.log(`📬 Response:`, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Supabase POST failed:', err.message);
  }

  console.log(`\n✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
})();
