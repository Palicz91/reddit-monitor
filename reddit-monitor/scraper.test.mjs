import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OLD,
  buildPages,
  dedupe,
  extractOldReddit,
  fromItem,
  loadEnv,
  loadPage,
  loadTexts,
  pickForBody,
  pruneTexts,
  savedMode,
  toPermalink,
  unreadable,
} from './scraper.mjs';

const nowMs = Date.now();
const now = nowMs / 1000;
const item = (over = {}) => ({
  kind: 'thing',
  id: 't3_abc',
  permalink: '/r/smallbusiness/comments/abc/x/',
  title: 'How do I remove a fake Google review?',
  createdMs: nowMs - 3600_000,
  author: 'owner1',
  subreddit: 'smallbusiness',
  comments: 2,
  score: 3,
  url: 'https://www.reddit.com/r/smallbusiness/comments/abc/x/',
  domain: 'self.smallbusiness',
  nsfw: false,
  promoted: false,
  stickied: false,
  locked: false,
  archived: false,
  flair: '',
  body: '',
  ...over,
});

test('fromItem keeps a title-only self post in the backend shape', () => {
  const p = fromItem(item(), now - 36 * 3600);
  assert.equal(p.title, 'How do I remove a fake Google review?');
  assert.equal(p.selftext, '');
  assert.equal(p.permalink, '/r/smallbusiness/comments/abc/x/');
  assert.equal(p.created_utc, Math.round((nowMs - 3600_000) / 1000));
  assert.equal(p.is_self, true);
  assert.equal(p.url, 'https://www.reddit.com/r/smallbusiness/comments/abc/x/');
  assert.equal(p.link_flair_text, undefined);
});

test('fromItem drops posts that cannot take a comment', () => {
  const cutoff = now - 36 * 3600;
  for (const over of [
    { locked: true },
    { archived: true },
    { stickied: true },
    { nsfw: true },
    { promoted: true },
    { author: '' },
    { author: '[deleted]' },
    { body: '[removed]' },
    { permalink: 'https://example.com/x' },
    { createdMs: 0 },
  ]) {
    assert.equal(fromItem(item(over), cutoff), null, JSON.stringify(over));
  }
});

test('fromItem drops posts older than the lookback window', () => {
  assert.equal(fromItem(item({ createdMs: nowMs - 40 * 3600_000 }), now - 36 * 3600), null);
});

test('fromItem: link post keeps the outside url; search hit with comments-link permalink', () => {
  const link = fromItem(item({ domain: 'yelp.com', url: 'https://yelp.com/biz/x' }), 0);
  assert.equal(link.is_self, false);
  assert.equal(link.url, 'https://yelp.com/biz/x');
  const s = fromItem(item({ kind: 'search', url: 'https://old.reddit.com/r/smallbusiness/comments/abc/x/' }), 0);
  assert.equal(s.is_self, true);
  const sl = fromItem(item({ kind: 'search', url: 'https://yelp.com/biz/x' }), 0);
  assert.equal(sl.is_self, false);
});

test('toPermalink accepts relative and reddit absolute links only', () => {
  assert.equal(toPermalink('https://old.reddit.com/r/a/comments/x1/t/'), '/r/a/comments/x1/t/');
  assert.equal(toPermalink('/r/a/comments/x1/t/'), '/r/a/comments/x1/t/');
  assert.equal(toPermalink('https://evilreddit.com/r/a/comments/x1/'), '');
  assert.equal(toPermalink('/user/bob'), '');
  assert.equal(toPermalink(null), '');
});

test('unreadable counts items without link or date', () => {
  assert.equal(unreadable([item(), item({ createdMs: 0 }), item({ permalink: '' })]).length, 2);
  // Profile posts (job ads on a user's own page) are skipped quietly, not a markup warning.
  assert.equal(unreadable([item({ permalink: 'https://old.reddit.com/user/Find_Your_Job/comments/1y05j5e/for_hire/' })]).length, 0);
  assert.equal(unreadable([item({ permalink: '/user/x/comments/abc/t/', createdMs: 0 })]).length, 0);
});

test('dedupe keeps the first copy by permalink', () => {
  const a = fromItem(item(), 0);
  const b = fromItem(item({ score: 99 }), 0);
  assert.equal(dedupe([a, b]).length, 1);
});

test('buildPages: one old-Reddit search per query, one /new per group', () => {
  const pages = buildPages({ searchQueries: ['"fake review"'], subredditGroups: [['a', 'b'], []] });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].search, true);
  assert.equal(pages[0].url, `${OLD}/search?q=%22fake%20review%22&sort=new&t=week&type=link`);
  assert.equal(pages[1].search, false);
  assert.equal(pages[1].url, `${OLD}/r/a+b/new/?limit=100`);
});

test('pickForBody: search hits first, then review-ish titles, skips posts with text, caps', () => {
  const p = (id, title, extra = {}) => ({ permalink: `/r/a/comments/${id}/`, title, selftext: '', created_utc: 1, ...extra });
  const posts = [p('1', 'Hiring tips'), p('2', 'Got a fake Yelp review'), p('3', 'anything'), p('4', 'google rating', { selftext: 'x' })];
  const picked = pickForBody(posts, new Set(['/r/a/comments/3/']), 5).map((x) => x.permalink);
  assert.deepEqual(picked, ['/r/a/comments/3/', '/r/a/comments/2/']);
  assert.equal(pickForBody(posts, new Set(['/r/a/comments/3/']), 1).length, 1);
});

test('loadEnv reads export-prefixed and quoted values, ignores comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, '# c\nexport RM_SECRET="abc"\nRM_ENDPOINT=https://x/y\n');
  assert.deepEqual(loadEnv(f), { RM_SECRET: 'abc', RM_ENDPOINT: 'https://x/y' });
  assert.deepEqual(loadEnv(join(dir, 'missing')), {});
});

test('savedMode falls back to headless and ignores unknown values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-mode-'));
  const env = { PROFILE_DIR: join(dir, 'chrome-profile') };
  assert.equal(savedMode(env), 'headless');
  writeFileSync(join(dir, 'browser-mode.txt'), 'window\n');
  assert.equal(savedMode(env), 'window');
  writeFileSync(join(dir, 'browser-mode.txt'), 'rm -rf\n');
  assert.equal(savedMode(env), 'headless');
});

test('text cache: bad file reads as empty, old or malformed entries are pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-texts-'));
  const env = { PROFILE_DIR: join(dir, 'chrome-profile') };
  assert.deepEqual(loadTexts(env), {});
  writeFileSync(join(dir, 'texts.json'), '[1,2]');
  assert.deepEqual(loadTexts(env), {});
  writeFileSync(join(dir, 'texts.json'), JSON.stringify({ a: { t: now - 3600, s: 'body' } }));
  assert.equal(loadTexts(env).a.s, 'body');
  assert.deepEqual(
    pruneTexts({ a: { t: now - 3600, s: '' }, b: { t: now - 200 * 3600, s: 'x' }, c: 5, d: { t: now } }, now),
    { a: { t: now - 3600, s: '' } }
  );
});

// ---------- browser: old-Reddit-shaped pages served locally (needs CHROME_PATH) ----------

const LISTING = `<!doctype html><html><body>
<div id="header"><div id="header-bottom-right"><span class="user"><a href="/user/monitor1/">monitor1</a></span></div></div>
<div id="siteTable">
 <div class="thing link self" data-fullname="t3_aaa" data-permalink="/r/smallbusiness/comments/aaa/fake_review/"
  data-timestamp="${nowMs - 3600_000}" data-author="owner1" data-subreddit="smallbusiness" data-comments-count="4"
  data-score="7" data-url="/r/smallbusiness/comments/aaa/fake_review/" data-domain="self.smallbusiness" data-nsfw="false" data-promoted="false">
  <p class="title"><a class="title" href="/r/smallbusiness/comments/aaa/fake_review/">Competitor left a fake Google review</a>
  <span class="linkflairlabel">Help</span></p>
  <div class="expando"><div class="usertext-body"><div class="md"><p>They never came in. How do I get it removed?</p></div></div></div>
 </div>
 <div class="thing link stickied" data-fullname="t3_bbb" data-permalink="/r/smallbusiness/comments/bbb/rules/"
  data-timestamp="${nowMs - 7200_000}" data-author="mod" data-subreddit="smallbusiness" data-domain="self.smallbusiness">
  <a class="title" href="/r/smallbusiness/comments/bbb/rules/">Weekly thread</a></div>
 <div class="thing comment" data-fullname="t1_ccc"><div class="md">a comment</div></div>
</div></body></html>`;

const SEARCH = `<!doctype html><html><body>
<div id="header"><div id="header-bottom-right"><span class="user">Want to join? <a class="login-required" href="/login">Log in or sign up</a></span></div></div>
<div class="search-result search-result-link" data-fullname="t3_ddd">
 <header class="search-result-header"><a class="search-title" href="https://www.yelp.com/biz/x">Yelp review from a non-customer</a></header>
 <div class="search-result-meta"><span class="search-score">12 points</span>
  <a class="search-comments" href="https://old.reddit.com/r/GoogleMyBusiness/comments/ddd/yelp_review/">1,203 comments</a>
  submitted <time datetime="${new Date(nowMs - 1800_000).toISOString()}">30 minutes ago</time>
  by <a class="author" href="/user/o2">o2</a> to <a class="search-subreddit-link" href="/r/GoogleMyBusiness/">r/GoogleMyBusiness</a></div>
 <div class="search-result-body"><div class="md">Short text</div></div>
</div></body></html>`;

const BLOCKED = `<!doctype html><html><body><h1>whoa there, pardner!</h1><p>Your request has been blocked due to a network policy.</p></body></html>`;

test('browser: reads old-Reddit listing and search pages, flags the block page', { skip: !process.env.CHROME_PATH }, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://old.reddit.com/**', (route) => {
      const u = route.request().url();
      if (u.includes('/blocked')) return route.fulfill({ status: 403, contentType: 'text/html', body: BLOCKED });
      return route.fulfill({ status: 200, contentType: 'text/html', body: u.includes('/search') ? SEARCH : LISTING });
    });
    const health = () => ({ requests: 1, ok: 0, failed: 0, statuses: {}, errors: [] });

    const h1 = health();
    const listing = await loadPage(page, `${OLD}/r/smallbusiness/new/`, h1);
    assert.equal(h1.ok, 1);
    assert.equal(listing.user, 'monitor1');
    assert.equal(listing.items.length, 2, 'the comment is not a post');
    const [p] = listing.items.map((it) => fromItem(it, now - 36 * 3600)).filter(Boolean);
    assert.equal(p.title, 'Competitor left a fake Google review');
    assert.equal(p.selftext, 'They never came in. How do I get it removed?');
    assert.equal(p.num_comments, 4);
    assert.equal(p.link_flair_text, 'Help');
    assert.equal(p.is_self, true);

    const h2 = health();
    const search = await loadPage(page, `${OLD}/search?q=x`, h2);
    assert.equal(search.user, null, 'logged-out header');
    const s = fromItem(search.items[0], now - 36 * 3600);
    assert.equal(s.permalink, '/r/GoogleMyBusiness/comments/ddd/yelp_review/');
    assert.equal(s.subreddit, 'GoogleMyBusiness');
    assert.equal(s.num_comments, 1203);
    assert.equal(s.score, 12);
    assert.equal(s.author, 'o2');
    assert.equal(s.is_self, false);
    assert.equal(s.url, 'https://www.yelp.com/biz/x');
    assert.equal(s.selftext, 'Short text');

    const h3 = health();
    assert.equal(await loadPage(page, `${OLD}/blocked`, h3), null);
    assert.equal(h3.loginWall, true);
    assert.equal(h3.failed, 1);
    assert.equal(h3.statuses[403], 1);
  } finally {
    await browser.close();
  }
});

test('extractOldReddit is self-contained (no outer references)', () => {
  // page.evaluate serialises the function; any closure variable would be undefined in the page.
  const src = extractOldReddit.toString();
  for (const name of ['toPermalink', 'fromItem', 'OLD', 'BODY_MAX_CHARS']) assert.ok(!src.includes(name), name);
});
