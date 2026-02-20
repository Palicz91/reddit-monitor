// supabase/functions/reddit-monitor/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('REDDIT_MONITOR_TG_TOKEN')!;
const TELEGRAM_CHAT_ID = Deno.env.get('REDDIT_MONITOR_TG_CHAT_ID')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

interface RedditPost {
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  created_utc: number;
  subreddit: string;
  num_comments: number;
  score: number;
}

interface ScoreResult {
  score: number;
  angle: string;
  reason: string;
}

interface RunConfig {
  keywords: string[];
  scorePrompt: string;
  draftPrompt: string;
  dailyDraftLimit: number;
  maxPerRun: number;
  minScore: number;
}

function parseConfig(body: any): RunConfig {
  return {
    keywords: ((body.keywords || Deno.env.get('KEYWORDS') || '') as string)
      .split(',')
      .map((k: string) => k.trim())
      .filter(Boolean),
    scorePrompt: body.scorePrompt || Deno.env.get('SCORE_PROMPT') || '',
    draftPrompt: body.draftPrompt || Deno.env.get('DRAFT_PROMPT') || '',
    dailyDraftLimit: parseInt(body.dailyDraftLimit || Deno.env.get('DAILY_DRAFT_LIMIT') || '8', 10),
    maxPerRun: parseInt(body.maxPerRun || Deno.env.get('MAX_PER_RUN') || '3', 10),
    minScore: parseInt(body.minScore || Deno.env.get('MIN_SCORE') || '6', 10),
  };
}

// ── Daily cap ──

async function getDraftsToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('reddit_monitor_state')
    .select('run_date, drafts_sent')
    .eq('id', 1)
    .single();

  if (error) {
    console.error('DB read error:', error.message);
    return 0;
  }

  if (data.run_date !== today) {
    await supabase
      .from('reddit_monitor_state')
      .update({ run_date: today, drafts_sent: 0 })
      .eq('id', 1);
    return 0;
  }

  return data.drafts_sent;
}

async function incrementDrafts(count: number): Promise<void> {
  const current = await getDraftsToday();
  await supabase
    .from('reddit_monitor_state')
    .update({ drafts_sent: current + count })
    .eq('id', 1);
}

// ── Scoring ──

function buildPostContext(post: RedditPost): string {
  return `Subreddit: r/${post.subreddit}
Title: ${post.title}
Content: ${post.selftext.slice(0, 1500)}
Score: ${post.score} | Comments: ${post.num_comments}
Age: ${Math.round((Date.now() / 1000 - post.created_utc) / 3600)}h old`;
}

function calculateBaseScore(post: RedditPost): number {
  let score = 0;
  const ageH = (Date.now() / 1000 - post.created_utc) / 3600;

  if (ageH < 3) score += 3;
  else if (ageH < 6) score += 2;
  else if (ageH < 12) score += 1;

  if (post.num_comments < 5) score += 2;
  else if (post.num_comments < 15) score += 1;

  if (post.score > 10) score += 1;

  return score;
}

async function scorePost(post: RedditPost, scorePrompt: string): Promise<ScoreResult> {
  const baseScore = calculateBaseScore(post);

  if (baseScore <= 1) {
    return { score: baseScore, angle: 'none', reason: 'too old or too many comments' };
  }

  try {
    const postContext = buildPostContext(post);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: scorePrompt,
        messages: [
          {
            role: 'user',
            content: `Score this post. Base score from age/comments: ${baseScore}/5\n\n${postContext}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error('Haiku score error:', res.status);
      return { score: baseScore, angle: 'unknown', reason: 'API failed' };
    }

    const data = await res.json();
    const text = data.content
      ?.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const aiScore = Math.min(4, Math.max(0, parsed.score || 0));
    return {
      score: Math.min(10, baseScore + aiScore),
      angle: parsed.angle || 'unknown',
      reason: parsed.reason || '',
    };
  } catch (e: any) {
    console.error('Score parse error:', e.message);
    return { score: baseScore, angle: 'unknown', reason: 'parse failed' };
  }
}

// ── Drafting ──

async function generateDraft(post: RedditPost, draftPrompt: string): Promise<string> {
  try {
    const postContext = buildPostContext(post);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: draftPrompt,
        messages: [
          {
            role: 'user',
            content: `Write a Reddit comment reply for this post. Be genuinely helpful first. Only mention your product if directly relevant.\n\n${postContext}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Claude API error:', res.status, errText.slice(0, 200));
      return '⚠️ Draft generation failed';
    }

    const data = await res.json();
    const text = data.content
      ?.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');

    return text || '⚠️ Empty response from Claude';
  } catch (e) {
    console.error('Draft generation error:', e);
    return '⚠️ Draft generation failed';
  }
}

// ── Telegram ──

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatPostScored(post: RedditPost, result: ScoreResult): string {
  const url = `https://reddit.com${post.permalink}`;
  const preview = post.selftext.slice(0, 150).replace(/\n/g, ' ');
  const ageHours = Math.round((Date.now() / 1000 - post.created_utc) / 3600);
  return `📊 <b>${result.score}/10</b> – ${escapeHtml(result.reason)}
🎯 Angle: ${escapeHtml(result.angle)}

<b>r/${post.subreddit}</b> (⬆${post.score} 💬${post.num_comments} 🕐${ageHours}h)
<b>${escapeHtml(post.title)}</b>
${escapeHtml(preview)}${post.selftext.length > 150 ? '...' : ''}
🔗 ${url}`;
}

function formatDraft(draft: string): string {
  return escapeHtml(draft);
}

async function sendTelegram(message: string) {
  const chunks = splitMessage(message, 4000);
  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      console.error('Telegram error:', await res.text());
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function isRelevant(post: RedditPost, keywords: string[]): boolean {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

// ── Main handler ──

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('REDDIT_MONITOR_CRON_SECRET');

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const handlerStart = Date.now();
  const reqUrl = new URL(req.url);
  const debug = reqUrl.searchParams.get('debug') === '1';
  const noDraft = reqUrl.searchParams.get('nodraft') === '1';

  try {
    // Cleanup seen posts older than 7 days
    await supabase
      .from('reddit_seen_posts')
      .delete()
      .lt('seen_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());

    if (req.method !== 'POST') {
      const draftsToday = await getDraftsToday();
      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'POST scraped posts to this endpoint. GET returns status only.',
          draftsToday,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();
    if (!body.posts || !Array.isArray(body.posts)) {
      return new Response(
        JSON.stringify({ error: 'POST body must have "posts" array' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const config = parseConfig(body);
    const allPosts: RedditPost[] = body.posts;
    console.log(`📥 Received ${allPosts.length} posts from ${body.source || 'unknown'}`);

    const debugInfo: any = { totalReceived: allPosts.length };

    // Dedup
    const seen = new Set<string>();
    const unique = allPosts.filter((p) => {
      const key = p.permalink || p.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Keyword filter
    const keywordMatched = unique
      .filter((p) => isRelevant(p, config.keywords))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    // Filter already-seen posts
    const seenKeys = keywordMatched.map((p) => p.permalink || p.title).filter(Boolean);
    let seenSet = new Set<string>();
    if (seenKeys.length > 0) {
      const { data: seenRows } = await supabase
        .from('reddit_seen_posts')
        .select('permalink')
        .in('permalink', seenKeys);
      seenSet = new Set((seenRows || []).map((r: any) => r.permalink));
    }
    const relevant = keywordMatched.filter((p) => !seenSet.has(p.permalink || p.title));

    debugInfo.uniquePosts = unique.length;
    debugInfo.keywordMatched = keywordMatched.length;
    debugInfo.alreadySeen = keywordMatched.length - relevant.length;
    debugInfo.relevantPosts = relevant.length;

    // Daily cap
    const draftsToday = await getDraftsToday();
    const slotsLeft = config.dailyDraftLimit - draftsToday;

    if (slotsLeft <= 0) {
      await sendTelegram(
        `✅ Daily draft limit reached (${draftsToday}/${config.dailyDraftLimit}). Resuming tomorrow.`
      );
      return new Response(
        JSON.stringify({ success: true, reason: 'daily_limit_reached', draftsToday }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Score
    const scored: { post: RedditPost; result: ScoreResult }[] = [];
    for (const post of relevant) {
      const result = await scorePost(post, config.scorePrompt);
      console.log(
        `Score: ${result.score}/10 | ${result.angle} | r/${post.subreddit} | ${post.title.slice(0, 60)}`
      );
      scored.push({ post, result });
      await new Promise((r) => setTimeout(r, 300));
    }

    // Qualify
    const qualified = scored
      .filter(({ result }) => result.score >= config.minScore && result.angle !== 'none')
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, Math.min(config.maxPerRun, slotsLeft));

    debugInfo.qualifiedCount = qualified.length;
    debugInfo.slotsLeft = slotsLeft;

    if (qualified.length === 0) {
      if (debug) {
        const topScores = scored
          .sort((a, b) => b.result.score - a.result.score)
          .slice(0, 5)
          .map(({ post, result }) => `• ${result.score}/10: ${post.title.slice(0, 50)}`)
          .join('\n');
        await sendTelegram(
          `📭 ${relevant.length} keyword matches, none scored ${config.minScore}+.\n\nTop scores:\n${topScores}`
        );
      }
    } else {
      const header = `🔔 <b>Reddit Monitor</b>\n${qualified.length} post${qualified.length > 1 ? 's' : ''} to comment on (${draftsToday}/${config.dailyDraftLimit} used today)\n\n💡 Copy the draft, tweak it, post it.`;
      await sendTelegram(header);

      let newDrafts = 0;
      for (const { post, result } of qualified) {
        let draft = '(draft disabled)';
        if (!noDraft && ANTHROPIC_API_KEY) {
          draft = await generateDraft(post, config.draftPrompt);
          newDrafts++;
          await new Promise((r) => setTimeout(r, 1000));
        }
        await sendTelegram(formatPostScored(post, result));
        await sendTelegram(formatDraft(draft));
      }

      if (newDrafts > 0) {
        await incrementDrafts(newDrafts);
        const seenInserts = qualified.map(({ post }) => ({
          permalink: post.permalink || post.title,
        }));
        await supabase.from('reddit_seen_posts').upsert(seenInserts);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        keywordMatches: relevant.length,
        qualified: qualified.length,
        draftsToday: draftsToday + qualified.length,
        slotsLeft: slotsLeft - qualified.length,
        totalReceived: allPosts.length,
        uniquePosts: unique.length,
        executionMs: Date.now() - handlerStart,
        debug: debugInfo,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Reddit monitor error:', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
