#!/usr/bin/env node
// Reddit monitor, laptop side. Runs from launchd on a Mac (residential IP: Reddit
// returns 403 to the VPS and other datacenter IPs for its JSON endpoints).
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Same browser UA the old scraper used from this laptop without being blocked.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
async function fetchListing(url, health, fetchImpl = fetch) {
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
    if (res.status === 429 && attempt === 0) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = Math.min(MAX_429_WAIT_MS, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 30_000);
      console.log(`  429, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    if (res.status !== 200) {
      health.failed++;
      health.errors.push(`HTTP ${res.status}: ${url.replace('https://www.reddit.com', '')}`.slice(0, 200));
      return [];
    }
    try {
      const json = await res.json();
      health.ok++;
      return json?.data?.children || [];
    } catch (err) {
      health.failed++;
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

async function main() {
  const env = { ...loadEnv(join(HERE, '.env')), ...process.env };
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
  for (const [i, url] of urls.entries()) {
    const children = await fetchListing(url, health);
    const kept = children.map((c) => toPost(c, cutoffUtc)).filter(Boolean);
    console.log(`  ${url.replace('https://www.reddit.com', '').slice(0, 90)} → ${children.length} items, ${kept.length} kept`);
    posts.push(...kept);
    if (i < urls.length - 1) await sleep(REQUEST_GAP_MS + Math.random() * 1500);
  }
  posts = dedupe(posts);
  health.durationS = Math.round((Date.now() - started) / 1000);
  console.log(`📊 ${health.ok}/${urls.length} requests ok, ${posts.length} posts in the last ${lookbackHours}h`);

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
