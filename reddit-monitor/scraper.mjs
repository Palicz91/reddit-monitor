#!/usr/bin/env node
// Reddit monitor, laptop side. Runs from launchd on a Mac.
//
// Why a real browser and HTML pages (2026-11-19): Reddit blocks every logged-out read and every
// non-browser client ("blocked by network security"), from home connections too, and refuses the
// .json listings even to a logged-in Chrome. Normal old.reddit.com pages still load for a
// logged-in Chrome, headless included. So this drives the Mac's installed Google Chrome
// (playwright-core, no bundled browser) on its own profile that you log into once
// (`./install-mac.sh login`), and reads old Reddit's search and subreddit pages.
//
// One run:
//   1. GET the backend for this run's settings (search queries, subreddits, lookback).
//   2. Load one old-Reddit search page per query (newest first, past week) and the /new page of
//      each subreddit group; read the posts from the page.
//   3. Drop posts that can't take a comment (locked, archived, removed, stickied, NSFW, ads) and
//      posts older than the lookback window.
//   4. Open posts that may be about reviews to read their text (capped per run; texts read in an
//      earlier run come from texts.json, so a post is opened once).
//   5. POST them to the backend with a health block (page loads, HTTP statuses), so a blocked run
//      is reported as blocked, not as a quiet day.
//
// Every run sends every recent post: the backend (ReviewTactic edge function `reddit-monitor`)
// scores at most 25 per run and leaves the rest for the next run, so it, not this file, keeps the
// seen-list. It also picks the
// removal-intent posts, scores, drafts and sends Telegram. Nothing here needs editing when
// queries or prompts change.
//
// Config: .env next to this file (see .env.example). Node 18+.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const OLD = 'https://old.reddit.com';
const DEFAULT_PROFILE_DIR = join(homedir(), 'Library', 'Application Support', 'reddit-monitor', 'chrome-profile');
const REQUEST_GAP_MS = 5500; // + 0-1.5 s jitter between page loads
const BODY_MAX_CHARS = 4000;
/** Post pages opened per run to read the text; the rest go title-only. */
export const MAX_BODY_FETCH = 20;
/** Subreddit posts whose title matches this get their text read; search hits always do. */
export const REVIEWISH_RE =
  /review|google|yelp|rating|stars?\b|reput|defam|fake|trustpilot|tripadvisor|listing|\bgmb\b|\bgbp\b|maps/i;
const TEXT_KEEP_HOURS = 96;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gap = () => sleep(REQUEST_GAP_MS + Math.random() * 1500);
const short = (url) => url.replace(OLD, '').slice(0, 84);

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

// ---------- state next to the Chrome profile ----------

export const BROWSER_MODES = ['headless', 'window'];
const profileDir = (env) => env.PROFILE_DIR || DEFAULT_PROFILE_DIR;
const stateFile = (env, name) => join(profileDir(env), '..', name);

/** The mode `check` last found working (headless when nothing is saved yet). */
export function savedMode(env) {
  try {
    const m = readFileSync(stateFile(env, 'browser-mode.txt'), 'utf8').trim();
    return BROWSER_MODES.includes(m) ? m : 'headless';
  } catch {
    return 'headless';
  }
}

function writeState(env, name, text) {
  try {
    mkdirSync(dirname(stateFile(env, name)), { recursive: true });
    writeFileSync(stateFile(env, name), text);
  } catch {
    /* best effort */
  }
}

/** Post texts read in earlier runs: { permalink: { t: unix seconds read, s: text } }. */
export function loadTexts(env) {
  try {
    const j = JSON.parse(readFileSync(stateFile(env, 'texts.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function pruneTexts(texts, nowS = Date.now() / 1000) {
  const out = {};
  for (const [k, v] of Object.entries(texts)) {
    if (v && typeof v.t === 'number' && typeof v.s === 'string' && nowS - v.t < TEXT_KEEP_HOURS * 3600) out[k] = v;
  }
  return out;
}

// ---------- browser ----------

/**
 * Opens Chrome with the monitor's own profile. Modes: 'visible' (login window), 'headless'
 * (no window), 'window' (a real window parked off-screen and minimized, if Reddit ever refuses
 * headless). CHROME_PATH / PROFILE_DIR override the defaults.
 */
export async function openBrowser(env, { mode = 'headless' } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('browser helper missing: run ./install-mac.sh once (it runs npm install)');
  }
  const opts = {
    headless: mode === 'headless',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1280, height: 900 },
  };
  if (env.CHROME_PATH) opts.executablePath = env.CHROME_PATH;
  else opts.channel = 'chrome';
  if (opts.headless) opts.userAgent = USER_AGENT; // headless Chrome says "HeadlessChrome" otherwise
  if (mode === 'window') opts.args.push('--window-position=-3000,-3000', '--window-size=1280,900');
  let context;
  try {
    mkdirSync(profileDir(env), { recursive: true });
    context = await chromium.launchPersistentContext(profileDir(env), opts);
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
  if (mode === 'window') {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch {
      /* off-screen position is enough */
    }
  }
  return { context, page, close: () => context.close().catch(() => {}) };
}

// ---------- reading old Reddit pages ----------

/**
 * Runs inside the page (passed to page.evaluate, so it must be self-contained). Reads the
 * logged-in username, listing posts (subreddit pages and a post's own page) and search results.
 */
export function extractOldReddit() {
  const text = (el) => (el ? el.textContent.trim() : '');
  const int = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/-?\d+/);
    return m ? Number(m[0]) : 0;
  };
  const bodyText = document.body ? document.body.innerText.slice(0, 3000) : '';
  const out = {
    blocked: /blocked by network security|blocked due to a network policy/i.test(bodyText),
    valid: !!document.querySelector('#header') && location.hostname === 'old.reddit.com',
    user: text(document.querySelector('#header-bottom-right span.user > a:not(.login-required)')) || null,
    items: [],
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('div.thing.link[data-fullname^="t3_"]')) {
    const id = el.getAttribute('data-fullname');
    if (seen.has(id)) continue;
    seen.add(id);
    const cls = el.classList;
    const md = el.querySelector('.expando .usertext-body .md');
    out.items.push({
      kind: 'thing',
      id,
      permalink: el.getAttribute('data-permalink') || '',
      title: text(el.querySelector('a.title')),
      createdMs: Number(el.getAttribute('data-timestamp')) || 0,
      author: el.getAttribute('data-author') || '',
      subreddit: el.getAttribute('data-subreddit') || '',
      comments: int(el.getAttribute('data-comments-count')),
      score: int(el.getAttribute('data-score')),
      url: el.getAttribute('data-url') || '',
      domain: el.getAttribute('data-domain') || '',
      nsfw: el.getAttribute('data-nsfw') === 'true' || cls.contains('over18'),
      promoted: el.getAttribute('data-promoted') === 'true' || cls.contains('promoted'),
      stickied: cls.contains('stickied'),
      locked: cls.contains('locked'),
      archived: cls.contains('archived'),
      flair: text(el.querySelector('.linkflairlabel')),
      body: md ? md.innerText.trim() : '',
    });
  }
  for (const el of document.querySelectorAll('div.search-result-link')) {
    const id = el.getAttribute('data-fullname') || '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const a = el.querySelector('a.search-title');
    const c = el.querySelector('a.search-comments');
    const t = el.querySelector('time[datetime]');
    const titleHref = a ? a.getAttribute('href') || '' : '';
    out.items.push({
      kind: 'search',
      id,
      // On a link post the title points at the outside site; the comments link is the permalink.
      permalink: (c && c.getAttribute('href')) || titleHref,
      title: text(a),
      createdMs: t ? Date.parse(t.getAttribute('datetime')) || 0 : 0,
      author: text(el.querySelector('a.author')),
      subreddit: text(el.querySelector('a.search-subreddit-link')).replace(/^\/?r\//, ''),
      comments: int(text(c)),
      score: int(text(el.querySelector('.search-score'))),
      url: titleHref,
      domain: '',
      nsfw: !!el.querySelector('.nsfw-stamp'),
      promoted: false,
      stickied: false,
      locked: false,
      archived: false,
      flair: text(el.querySelector('.linkflairlabel')),
      body: text(el.querySelector('.search-result-body .md') || el.querySelector('.search-result-body')),
    });
  }
  return out;
}

/** "/r/x/comments/id/slug/" from a relative or absolute Reddit link, or '' when it isn't one. */
export function toPermalink(link) {
  let p = String(link || '');
  if (/^https?:\/\//.test(p)) {
    try {
      const u = new URL(p);
      if (!/(^|\.)reddit\.com$/.test(u.hostname)) return '';
      p = u.pathname;
    } catch {
      return '';
    }
  }
  return /^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(p) ? p : '';
}

/** Map one item read from a page to the backend payload shape, or null when it can't take a comment. */
export function fromItem(it, cutoffUtc) {
  if (!it || it.nsfw || it.promoted || it.stickied || it.locked || it.archived) return null;
  if (!it.author || it.author === '[deleted]' || it.body === '[removed]' || it.body === '[deleted]') return null;
  const permalink = toPermalink(it.permalink);
  const created = Math.round((it.createdMs || 0) / 1000);
  if (!permalink || !created || created < cutoffUtc) return null;
  const isSelf =
    it.kind === 'search' ? !it.url || toPermalink(it.url) === permalink : String(it.domain).startsWith('self.');
  return {
    title: String(it.title || ''),
    selftext: String(it.body || '').slice(0, BODY_MAX_CHARS),
    url: isSelf || !it.url ? `https://www.reddit.com${permalink}` : String(it.url),
    permalink,
    created_utc: created,
    subreddit: String(it.subreddit || permalink.split('/')[2] || ''),
    num_comments: Number(it.comments || 0),
    score: Number(it.score || 0),
    author: String(it.author),
    link_flair_text: it.flair ? String(it.flair) : undefined,
    is_self: isSelf,
  };
}

/** A post on someone's own profile (/user/x/comments/...): readable, just not in a subreddit, so skipped quietly. */
export const isProfilePost = (link) => /^(?:https?:\/\/[^/]*reddit\.com)?\/(?:user|u)\/[^/]+\/comments\//i.test(String(link || ''));

/** Items the page had but that lack a link or date: a sign Reddit changed its markup. */
export const unreadable = (items) =>
  items.filter((it) => !isProfilePost(it.permalink) && (!toPermalink(it.permalink) || !it.createdMs));

export function dedupe(posts) {
  const seen = new Set();
  return posts.filter((p) => {
    if (seen.has(p.permalink)) return false;
    seen.add(p.permalink);
    return true;
  });
}

/** Pages to load: one search per query, one /new per subreddit group. */
export function buildPages(settings) {
  const pages = [];
  for (const q of settings.searchQueries || []) {
    pages.push({ search: true, url: `${OLD}/search?q=${encodeURIComponent(q)}&sort=new&t=week&type=link` });
  }
  for (const group of settings.subredditGroups || []) {
    if (!group.length) continue;
    pages.push({ search: false, url: `${OLD}/r/${group.map(encodeURIComponent).join('+')}/new/?limit=100` });
  }
  return pages;
}

/** Which new posts get their page opened for the text: search hits first, then review-ish titles. */
export function pickForBody(posts, fromSearch, cap = MAX_BODY_FETCH) {
  const want = posts.filter((p) => !p.selftext && (fromSearch.has(p.permalink) || REVIEWISH_RE.test(p.title)));
  want.sort(
    (a, b) => Number(fromSearch.has(b.permalink)) - Number(fromSearch.has(a.permalink)) || b.created_utc - a.created_utc
  );
  return want.slice(0, cap);
}

/** Load one old-Reddit page and read it; counts into health. Returns the extract or null. */
export async function loadPage(page, url, health) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 'none';
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      status = resp ? resp.status() : 'none';
    } catch (err) {
      health.failed++;
      health.lastStatus = 'none';
      health.errors.push(`load: ${String(err.message).split('\n')[0]} ${short(url)}`.slice(0, 200));
      return null;
    }
    health.statuses[status] = (health.statuses[status] || 0) + 1;
    health.lastStatus = status;
    if (status === 429 && attempt === 0) {
      console.log('  429 (too many requests), waiting 30s');
      await sleep(30_000);
      continue;
    }
    const data = await page.evaluate(extractOldReddit).catch(() => null);
    if (status === 200 && data && data.valid && !data.blocked) {
      health.ok++;
      return data;
    }
    health.failed++;
    if (status === 403 || data?.blocked) health.loginWall = true;
    health.errors.push(`HTTP ${status}${data?.blocked ? ' block page' : ''}: ${short(url)}`.slice(0, 200));
    return null;
  }
  health.failed++;
  return null;
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

// ---------- commands ----------

const LOGIN_HINT = 'Reddit wants a login: run ./install-mac.sh login and log in in the Chrome window.';
const TEST_URL = `${OLD}/r/GoogleMyBusiness/new/`;
const who = (u) => (u ? `logged in as u/${u}` : 'NOT logged in');

/** One test page in an open browser. */
async function probe(b) {
  const health = { requests: 1, ok: 0, failed: 0, statuses: {}, errors: [] };
  const data = await loadPage(b.page, TEST_URL, health);
  return { ok: !!data, status: health.lastStatus ?? 'none', count: data ? data.items.length : 0, user: data?.user || null };
}

/** `node scraper.mjs login`: visible Chrome on the monitor profile; you log in, press Enter. */
async function login(env) {
  const b = await openBrowser(env, { mode: 'visible' });
  await b.page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('👉 Log in to Reddit in the Chrome window that just opened (a spare account is fine).');
  console.log('   When you see your Reddit home page (your avatar top right), come back here and press Enter.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question('', () => r()));
  rl.close();
  let p;
  try {
    p = await probe(b);
  } finally {
    await b.close();
  }
  console.log(`   In the login window: ${who(p.user)}, Reddit answered HTTP ${p.status}${p.ok ? ` (${p.count} posts)` : ''}.`);
  if (!p.user) {
    console.log('❌ The login did not stick. Run ./install-mac.sh login again and log in before pressing Enter.');
    process.exitCode = 1;
    return;
  }
  await check(env);
}

/**
 * `node scraper.mjs check`: tries the background modes (headless, then a hidden window) and
 * remembers the first one Reddit accepts, so scheduled runs use it. No backend call.
 */
async function check(env) {
  for (const mode of BROWSER_MODES) {
    let b;
    try {
      b = await openBrowser(env, { mode });
    } catch (err) {
      console.log(`❌ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    let p;
    try {
      p = await probe(b);
    } finally {
      await b.close();
    }
    const label = mode === 'headless' ? 'background (no window)' : 'background (hidden window)';
    if (p.ok && p.count > 0) {
      writeState(env, 'browser-mode.txt', `${mode}\n`);
      console.log(`✅ Reddit OK in ${label} mode: ${who(p.user)}, ${p.count} posts read. Scheduled runs will use this mode.`);
      return;
    }
    console.log(`   ${label}: Reddit refused or showed no posts (HTTP ${p.status}), ${who(p.user)}.`);
  }
  console.log(`❌ Reddit refused every mode. ${LOGIN_HINT}`);
  process.exitCode = 1;
}

async function run(env) {
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
  const pages = buildPages(settings);
  const health = { requests: 0, ok: 0, failed: 0, statuses: {}, errors: [], settingsFromBackend: fromBackend };
  const texts = pruneTexts(loadTexts(env));
  let posts = [];
  const fromSearch = new Set();
  const badItems = [];

  let browser = null;
  try {
    browser = await openBrowser(env, { mode: savedMode(env) });
  } catch (err) {
    // Still report to the backend: ok = 0 makes it send the "blocked" Telegram alert.
    console.log(`❌ ${err.message}`);
    health.requests = pages.length;
    health.failed = pages.length;
    health.errors.push(`browser: ${err.message}`.slice(0, 200));
  }
  if (browser) {
    try {
      for (const [i, pg] of pages.entries()) {
        health.requests++;
        const data = await loadPage(browser.page, pg.url, health);
        const items = data ? data.items : [];
        badItems.push(...unreadable(items));
        const kept = items.map((it) => fromItem(it, cutoffUtc)).filter(Boolean);
        for (const p of kept) if (!p.selftext && texts[p.permalink]) p.selftext = texts[p.permalink].s;
        if (pg.search) for (const p of kept) fromSearch.add(p.permalink);
        console.log(`  HTTP ${health.lastStatus ?? '-'} ${short(pg.url)} → ${items.length} items, ${kept.length} recent`);
        posts.push(...kept);
        if (i < pages.length - 1) await gap();
      }
      posts = dedupe(posts);
      const toRead = pickForBody(posts.filter((p) => !texts[p.permalink]), fromSearch);
      if (toRead.length) console.log(`  reading the text of ${toRead.length} posts`);
      for (const p of toRead) {
        await gap();
        health.requests++;
        const data = await loadPage(browser.page, `${OLD}${p.permalink}`, health);
        const it = data?.items.find((x) => toPermalink(x.permalink) === p.permalink);
        if (!it) continue;
        const full = fromItem(it, 0);
        if (!full) {
          posts = posts.filter((x) => x.permalink !== p.permalink); // locked/removed since the listing
          continue;
        }
        texts[p.permalink] = { t: Math.round(Date.now() / 1000), s: full.selftext };
        if (full.selftext) p.selftext = full.selftext;
        if (full.link_flair_text && !p.link_flair_text) p.link_flair_text = full.link_flair_text;
      }
    } finally {
      await browser.close();
      writeState(env, 'texts.json', JSON.stringify(texts));
    }
  }
  if (badItems.length) {
    const eg = `${badItems[0].kind} "${String(badItems[0].title).slice(0, 40)}" link=${String(badItems[0].permalink).slice(0, 60) || '-'} date=${badItems[0].createdMs || '-'}`;
    health.errors.push(`parse: ${badItems.length} posts without a link or date, e.g. ${eg}`.slice(0, 200));
    console.log(`⚠️ ${badItems.length} posts had no link or date (e.g. ${eg}).`);
  }
  health.durationS = Math.round((Date.now() - started) / 1000);
  console.log(`📊 ${health.ok}/${health.requests} pages ok, ${posts.length} posts in the last ${lookbackHours}h`);
  if (health.loginWall) console.log(`❌ ${LOGIN_HINT}`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ source: 'laptop-scraper/3', posts, health }),
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

async function main() {
  const env = { ...loadEnv(join(HERE, '.env')), ...process.env };
  const cmd = process.argv[2];
  if (cmd === 'login') return login(env);
  if (cmd === 'check') return check(env);
  return run(env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
