#!/usr/bin/env node
// Reddit monitor, laptop side. Runs from launchd on a Mac. Since Nov 2026 Reddit blocks
// every logged-out read ("blocked by network security") and every non-browser client
// (curl and Node fetch still got 403 with a login cookie), from home connections too.
// So requests go through the Mac's real Google Chrome (playwright-core, no bundled browser)
// with its own profile that you log into once: `./install-mac.sh login`.
//
// One run:
//   1. GET the backend for this run's settings (search queries, subreddits, lookback).
//   2. Fetch Reddit JSON: one Reddit-wide search per query + /new of each subreddit group.
//   3. Drop posts that can't take a comment (locked, archived, removed, stickied, NSFW)
//      and posts older than the lookback window.
//   4. POST everything to the backend with a health block (request counts, HTTP statuses),
//      so a blocked run is reported as blocked, not as a quiet day.
//
// The backend (ReviewTactic edge function `reddit-monitor`) keeps the seen-list, picks the
// removal-intent posts, scores, drafts and sends Telegram. Nothing here needs editing when
// queries or prompts change.
//
// Config: .env next to this file (see .env.example). Node 18+, no dependencies.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Same browser UA the old scraper used from this laptop without being blocked.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Reddit's block pages for logged-out or rejected-login requests (two wordings seen, Nov 2026). */
export const LOGIN_WALL_RE = /blocked by network security|blocked due to a network policy|try logging in/i;

const DEFAULT_PROFILE_DIR = join(homedir(), 'Library', 'Application Support', 'reddit-monitor', 'chrome-profile');

/** Wraps a page-context fetch result in the small Response shape fetchListing reads. */
export function toResponse(r) {
  return {
    status: r.status,
    headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] ?? null },
    text: async () => r.text,
  };
}

/**
 * Opens Chrome with the monitor's own profile and returns a fetch that runs inside a
 * reddit.com tab, so Reddit sees a normal logged-in browser. `visible` shows the window
 * (login); otherwise Chrome runs headless. CHROME_PATH / PROFILE_DIR override the defaults.
 */
export async function openBrowser(env, { visible = false } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('browser helper missing: run ./install-mac.sh once (it runs npm install)');
  }
  const opts = {
    headless: !visible && env.BROWSER_HEADLESS !== '0',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1280, height: 900 },
  };
  if (env.CHROME_PATH) opts.executablePath = env.CHROME_PATH;
  else opts.channel = 'chrome';
  if (opts.headless) opts.userAgent = USER_AGENT; // headless Chrome says "HeadlessChrome" otherwise
  let context;
  try {
    context = await chromium.launchPersistentContext(env.PROFILE_DIR || DEFAULT_PROFILE_DIR, opts);
  } catch (err) {
    const msg = String(err.message || err);
    if (/ProcessSingleton|SingletonLock|already in use/i.test(msg)) {
      throw new Error('the monitor Chrome profile is already open (a login window or another run); close it and retry');
    }
    if (/chrome.*(not found|is not found|distribution)/i.test(msg)) {
      throw new Error('Google Chrome not found: install it from google.com/chrome');
    }
    throw err;
  }
  const page = context.pages()[0] || (await context.newPage());
  const fetchImpl = async (url) => {
    if (!page.url().startsWith('https://www.reddit.com')) {
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    const r = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return {
        status: res.status,
        headers: { 'x-ratelimit-reset': res.headers.get('x-ratelimit-reset') },
        text: await res.text(),
      };
    }, url);
    return toResponse(r);
  };
  return { context, page, fetchImpl, close: () => context.close().catch(() => {}) };
}

// Used only when the backend GET fails, so a backend hiccup still yields a useful run.
export const FALLBACK_SETTINGS = {
  searchQueries: [
    '"remove google review"',
    '"fake google review"',
    '"fake review" google business',
    '"negative review" removed',
    '"bad review" google remove',
    '"review bombed"',
  ],
  subredditGroups: [['GoogleMyBusiness', 'LocalSEO', 'smallbusiness', 'restaurateur', 'sweatystartup']],
  lookbackHours: 36,
};

const REQUEST_GAP_MS = 5500; // + 0-1.5 s jitter = ~6.25 s average, under the ~10/min unauthenticated Reddit allows
const MAX_429_WAIT_MS = 60_000;
const BODY_MAX_CHARS = 4000;

export function loadEnv(path) {
  const env = {};
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return env;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Map one Reddit listing child to the payload shape, or null when it can't take a comment. */
export function toPost(child, cutoffUtc) {
  if (!child || child.kind !== 't3' || !child.data) return null;
  const d = child.data;
  if (d.locked || d.archived || d.stickied || d.over_18) return null;
  if (d.removed_by_category) return null;
  if (d.author === '[deleted]' || d.selftext === '[removed]' || d.selftext === '[deleted]') return null;
  if (!d.permalink || !d.created_utc || d.created_utc < cutoffUtc) return null;
  return {
    title: String(d.title || ''),
    selftext: String(d.selftext || '').slice(0, BODY_MAX_CHARS),
    url: String(d.url || ''),
    permalink: String(d.permalink),
    created_utc: Number(d.created_utc),
    subreddit: String(d.subreddit || ''),
    num_comments: Number(d.num_comments || 0),
    score: Number(d.score || 0),
    author: d.author ? String(d.author) : undefined,
    link_flair_text: d.link_flair_text ? String(d.link_flair_text) : undefined,
    is_self: Boolean(d.is_self),
  };
}

export function dedupe(posts) {
  const seen = new Set();
  return posts.filter((p) => {
    if (seen.has(p.permalink)) return false;
    seen.add(p.permalink);
    return true;
  });
}

export function buildUrls(settings) {
  const urls = [];
  for (const q of settings.searchQueries || []) {
    urls.push(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=week&limit=100&type=link&raw_json=1`
    );
  }
  for (const group of settings.subredditGroups || []) {
    if (!group.length) continue;
    urls.push(`https://www.reddit.com/r/${group.map(encodeURIComponent).join('+')}/new.json?limit=100&raw_json=1`);
  }
  return urls;
}

/** Fetch one listing. One retry after a 429, waiting what Reddit asks for (capped). */
export async function fetchListing(url, health, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (err) {
      health.errors.push(`network: ${err.message}`.slice(0, 200));
      health.failed++;
      return [];
    }
    health.statuses[res.status] = (health.statuses[res.status] || 0) + 1;
    health.lastStatus = res.status;
    if (res.status === 429 && attempt === 0) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = Math.min(MAX_429_WAIT_MS, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 30_000);
      console.log(`  429, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    const body = await res.text().catch(() => '');
    if (LOGIN_WALL_RE.test(body)) health.loginWall = true;
    if (res.status !== 200) {
      health.failed++;
      health.errors.push(`HTTP ${res.status}: ${url.replace('https://www.reddit.com', '')}`.slice(0, 200));
      return [];
    }
    try {
      const json = JSON.parse(body);
      health.ok++;
      return json?.data?.children || [];
    } catch (err) {
      health.failed++;
      if (/<html/i.test(body)) health.loginWall = true; // login page instead of JSON
      health.errors.push(`bad JSON (${err.message}): ${url.replace('https://www.reddit.com', '')}`.slice(0, 200));
      return [];
    }
  }
  health.failed++;
  return [];
}

async function getSettings(endpoint, secret) {
  try {
    const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401) throw new Error('backend says 401: check RM_SECRET in .env');
    if (!res.ok) throw new Error(`backend GET HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.searchQueries) || !Array.isArray(body.subredditGroups)) {
      throw new Error('backend GET returned no settings');
    }
    return { settings: body, fromBackend: true };
  } catch (err) {
    if (String(err.message).includes('401')) throw err;
    console.log(`⚠️ ${err.message}; using built-in settings`);
    return { settings: FALLBACK_SETTINGS, fromBackend: false };
  }
}

const LOGIN_HINT = 'Reddit wants a login: run ./install-mac.sh login and log in in the Chrome window.';

/** `node scraper.mjs login`: visible Chrome on the monitor profile; you log in, press Enter. */
async function login(env) {
  const b = await openBrowser(env, { visible: true });
  await b.page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('👉 Log in to Reddit in the Chrome window that just opened (a spare account is fine).');
  console.log('   When you see your Reddit home page, come back here and press Enter.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question('', () => r()));
  rl.close();
  await b.close();
  await check(env);
}

/** `node scraper.mjs check`: one Reddit request through Chrome; says whether reading works. No backend call. */
async function check(env) {
  const b = await openBrowser(env);
  const health = { requests: 1, ok: 0, failed: 0, statuses: {}, errors: [] };
  let children = [];
  try {
    children = await fetchListing('https://www.reddit.com/r/GoogleMyBusiness/new.json?limit=5&raw_json=1', health, b.fetchImpl);
  } finally {
    await b.close();
  }
  if (health.ok) {
    console.log(`✅ Reddit OK (HTTP ${health.lastStatus}, ${children.length} posts read).`);
    return;
  }
  console.log(`❌ Reddit refused (HTTP ${health.lastStatus ?? 'none'}). ${health.loginWall ? LOGIN_HINT : health.errors.join('; ')}`);
  process.exitCode = 1;
}

async function main() {
  const env = { ...loadEnv(join(HERE, '.env')), ...process.env };
  if (process.argv[2] === 'login') return login(env);
  if (process.argv[2] === 'check') return check(env);
  const endpoint = env.RM_ENDPOINT;
  const secret = env.RM_SECRET;
  if (!endpoint || !secret) {
    console.error('❌ RM_ENDPOINT and RM_SECRET must be set in .env (see .env.example)');
    process.exit(2);
  }

  const started = Date.now();
  console.log(`\n🚀 Reddit monitor ${new Date().toISOString()}`);
  const { settings, fromBackend } = await getSettings(endpoint, secret);
  const lookbackHours = Number(settings.lookbackHours) > 0 ? Number(settings.lookbackHours) : 36;
  const cutoffUtc = Date.now() / 1000 - lookbackHours * 3600;

  const urls = buildUrls(settings);
  const health = { requests: urls.length, ok: 0, failed: 0, statuses: {}, errors: [], settingsFromBackend: fromBackend };
  let posts = [];
  let browser;
  try {
    browser = await openBrowser(env);
  } catch (err) {
    // Still report to the backend: ok = 0 makes it send the "blocked" Telegram alert.
    console.log(`❌ ${err.message}`);
    health.failed = urls.length;
    health.errors.push(`browser: ${err.message}`.slice(0, 200));
    browser = { fetchImpl: null, close: async () => {} };
  }
  try {
    for (const [i, url] of (browser.fetchImpl ? urls : []).entries()) {
      const children = await fetchListing(url, health, browser.fetchImpl);
      const kept = children.map((c) => toPost(c, cutoffUtc)).filter(Boolean);
      console.log(`  HTTP ${health.lastStatus ?? '-'} ${url.replace('https://www.reddit.com', '').slice(0, 84)} → ${children.length} items, ${kept.length} kept`);
      posts.push(...kept);
      if (i < urls.length - 1) await sleep(REQUEST_GAP_MS + Math.random() * 1500);
    }
  } finally {
    await browser.close();
  }
  posts = dedupe(posts);
  health.durationS = Math.round((Date.now() - started) / 1000);
  console.log(`📊 ${health.ok}/${urls.length} requests ok, ${posts.length} posts in the last ${lookbackHours}h`);
  if (health.loginWall) console.log(`❌ ${LOGIN_HINT}`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ source: 'laptop-scraper/2', posts, health }),
    });
  } catch (err) {
    console.error(`❌ backend POST failed: ${err.message}`);
    process.exit(1);
  }
  const text = await res.text();
  console.log(`📬 ${res.status} ${text.slice(0, 1500)}`);
  if (!res.ok) process.exit(1);
  console.log(`✅ done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
