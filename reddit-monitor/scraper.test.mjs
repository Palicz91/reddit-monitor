import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUrls, dedupe, loadEnv, toPost } from './scraper.mjs';

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
