import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUrls, dedupe, fetchListing, loadEnv, redditHeaders, toPost } from './scraper.mjs';

const now = Date.now() / 1000;
const child = (over = {}) => ({
  kind: 't3',
  data: {
    title: 'How do I remove a fake Google review?',
    selftext: '',
    permalink: '/r/smallbusiness/comments/abc/x/',
    created_utc: now - 3600,
    subreddit: 'smallbusiness',
    num_comments: 2,
    score: 3,
    author: 'owner1',
    ...over,
  },
});

test('keeps a title-only post (screenshot posts have no body)', () => {
  const p = toPost(child(), now - 36 * 3600);
  assert.equal(p.title, 'How do I remove a fake Google review?');
  assert.equal(p.selftext, '');
});

test('drops posts that cannot take a comment', () => {
  const cutoff = now - 36 * 3600;
  for (const over of [
    { locked: true },
    { archived: true },
    { stickied: true },
    { over_18: true },
    { removed_by_category: 'moderator' },
    { author: '[deleted]' },
    { selftext: '[removed]' },
  ]) {
    assert.equal(toPost(child(over), cutoff), null, JSON.stringify(over));
  }
});

test('drops posts older than the lookback window', () => {
  assert.equal(toPost(child({ created_utc: now - 40 * 3600 }), now - 36 * 3600), null);
});

test('dedupe keeps the first copy by permalink', () => {
  const a = toPost(child(), 0);
  const b = toPost(child({ score: 99 }), 0);
  assert.equal(dedupe([a, b]).length, 1);
});

test('buildUrls: one search per query, one multireddit per group', () => {
  const urls = buildUrls({ searchQueries: ['"fake review"'], subredditGroups: [['a', 'b'], []] });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /search\.json\?q=%22fake%20review%22&sort=new/);
  assert.match(urls[1], /\/r\/a\+b\/new\.json/);
});

test('loadEnv reads export-prefixed and quoted values, ignores comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, '# c\nexport RM_SECRET="abc"\nRM_ENDPOINT=https://x/y\n');
  assert.deepEqual(loadEnv(f), { RM_SECRET: 'abc', RM_ENDPOINT: 'https://x/y' });
  assert.deepEqual(loadEnv(join(dir, 'missing')), {});
});

test('redditHeaders: bare value becomes reddit_session, full header kept, none without cookie', () => {
  assert.equal(redditHeaders('').Cookie, undefined);
  assert.equal(redditHeaders(undefined).Cookie, undefined);
  assert.equal(redditHeaders('eyJhbGciOi.eyJzdWIi.c2ln').Cookie, 'reddit_session=eyJhbGciOi.eyJzdWIi.c2ln');
  assert.equal(redditHeaders('eyJhbGciOi.eyJzdWIi.c2ln=').Cookie, 'reddit_session=eyJhbGciOi.eyJzdWIi.c2ln=');
  assert.equal(redditHeaders('  Cookie: loid=1; reddit_session=abc ').Cookie, 'loid=1; reddit_session=abc');
  assert.equal(redditHeaders('reddit_session=abc').Cookie, 'reddit_session=abc');
  assert.match(redditHeaders('x')['User-Agent'], /Mozilla/);
});

const fakeRes = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k] ?? null },
  text: async () => body,
});
const newHealth = () => ({ requests: 1, ok: 0, failed: 0, statuses: {}, errors: [] });

test('fetchListing: 403 block page is flagged as a login wall', async () => {
  const h = newHealth();
  const out = await fetchListing('https://www.reddit.com/r/x/new.json', h, async () =>
    fakeRes(403, "You've been blocked by network security.\nTo continue, log in to your Reddit account")
  );
  assert.deepEqual(out, []);
  assert.equal(h.failed, 1);
  assert.equal(h.loginWall, true);
  assert.equal(h.lastStatus, 403);
  assert.equal(h.statuses[403], 1);
});

test('fetchListing: "network policy" block page (rejected cookie) is a login wall too', async () => {
  const h = newHealth();
  await fetchListing('u', h, async () =>
    fakeRes(403, '<h1>whoa there, pardner!</h1><p>Your request has been blocked due to a network policy.</p>')
  );
  assert.equal(h.loginWall, true);
});

test('fetchListing: HTML login page with 200 counts as failed login wall', async () => {
  const h = newHealth();
  const out = await fetchListing('u', h, async () => fakeRes(200, '<!DOCTYPE html><html><body>Log in</body></html>'));
  assert.deepEqual(out, []);
  assert.equal(h.ok, 0);
  assert.equal(h.failed, 1);
  assert.equal(h.loginWall, true);
});

test('fetchListing: JSON listing is read and the cookie header is sent', async () => {
  const h = newHealth();
  let sent;
  const out = await fetchListing(
    'u',
    h,
    async (_url, init) => {
      sent = init.headers;
      return fakeRes(200, JSON.stringify({ data: { children: [{ kind: 't3', data: {} }] } }));
    },
    redditHeaders('abc')
  );
  assert.equal(out.length, 1);
  assert.equal(h.ok, 1);
  assert.equal(h.loginWall, undefined);
  assert.equal(sent.Cookie, 'reddit_session=abc');
});
