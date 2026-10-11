import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { collectArticleLinks, MAX_COLLECTION_ARTICLES, parseArticleFeed, parseArticleSitemap } from '../packages/domain/src/article-collection';
import { resolvePublication } from '../packages/domain/src/article-dates';
import { feedPreview } from '../packages/domain/src/site-detection';
import type { PageFetcher } from '../packages/domain/src/safe-http';

const base = 'https://news.example.com';
const observed = new Date('2026-10-11T08:00:00Z');
const fixture = (name: string) => readFile(new URL(`./fixtures/sites/${name}`, import.meta.url), 'utf8');
function rssItems(count: number, offset = 0): string {
 return `<rss><channel>${Array.from({ length: count }, (_, index) => `<item><title>Article ${index + offset}</title><link>${base}/story-${index + offset}</link><pubDate>Sun, 11 Oct 2026 12:00:00 +0600</pubDate></item>`).join('')}</channel></rss>`;
}
function sitemapItems(count: number, offset = 0): string {
 return `<urlset>${Array.from({ length: count }, (_, index) => `<url><loc>${base}/story-${index + offset}</loc></url>`).join('')}</urlset>`;
}
function indexMap(children: string[]): string {
 return `<sitemapindex>${children.map(url => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`;
}
function fetcher(pages: Record<string, string>, calls: string[]): PageFetcher {
 return async (url, signal) => {
  signal.throwIfAborted();
  calls.push(url);
  if (!(url in pages)) throw new Error('HTTP 404');
  return { url, body: pages[url], contentType: 'application/xml' };
 };
}

test('RSS collection includes full discovery beyond the eight-link preview and immutable date provenance', () => {
 const xml = rssItems(12);
 assert.equal(feedPreview(xml, base).length, 8);
 const articles = parseArticleFeed(xml, base, observed);
 assert.equal(articles.length, 12);
 assert.equal(articles[11].url, `${base}/story-11`);
 assert.equal(articles[0].source, 'rss');
 assert.equal(articles[0].discoveredAt, observed);
 assert.deepEqual(articles[0].dateEvidence, [{ raw: 'Sun, 11 Oct 2026 12:00:00 +0600', source: 'feed', observedAt: observed }]);
});

test('Atom uses alternate links and published, never updated; RSS supports namespace publication dates', async () => {
 const atom = parseArticleFeed(await fixture('atom.xml'), base, observed);
 assert.equal(atom.length, 1);
 assert.equal(atom[0].url, `${base}/atom-story`);
 assert.equal(atom[0].dateEvidence[0].raw, '2026-10-11T08:00:00+06:00');
 const updateOnly = '<feed><entry><link rel="alternate" href="/updated-only"/><updated>2026-10-11T09:00:00+06:00</updated></entry></feed>';
 assert.deepEqual(parseArticleFeed(updateOnly, base, observed)[0].dateEvidence, []);
 const namespaced = '<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><link>/dc-story</link><dc:date>2026-10-11T12:00:00+06:00</dc:date></item></channel></rss>';
 assert.equal(parseArticleFeed(namespaced, base, observed)[0].dateEvidence[0].raw, '2026-10-11T12:00:00+06:00');
});

test('news sitemaps provide publication evidence while regular lastmod is never a publication date', async () => {
 const result = parseArticleSitemap(await fixture('news-sitemap.xml'), base, observed);
 assert.equal(result.discoveries.length, 2);
 assert.deepEqual(result.discoveries[0].dateEvidence, [{ raw: '2026-10-11T12:00:00+06:00', source: 'news-sitemap', observedAt: observed }]);
 assert.deepEqual(result.discoveries[1].dateEvidence, []);
 assert.equal(result.discoveries[0].discoveredAt, observed);
 assert.deepEqual(result.children, []);
 const children = parseArticleSitemap(indexMap(['/first.xml', 'http://127.0.0.1/private', '/second.xml']), `${base}/maps/index.xml`, observed);
 assert.deepEqual(children.children, [`${base}/first.xml`, `${base}/second.xml`]);
});

test('discovery preserves the fetch resource and rejects unsafe article links', () => {
 const xml = `<rss><channel>
  <item><link>/slash-sensitive/</link></item>
  <item><link>http://127.0.0.1/private</link></item>
  <item><link>https://user:secret@news.example.com/secret</link></item>
  <item><link>javascript:alert(1)</link></item>
  <item><title>Missing link</title></item>
 </channel></rss>`;
 assert.deepEqual(parseArticleFeed(xml, base, observed).map(article => article.url), [`${base}/slash-sensitive/`]);
 assert.equal(parseArticleSitemap(`<urlset><url><loc>${base}/slash-sensitive/</loc></url></urlset>`, base, observed).discoveries[0].url, `${base}/slash-sensitive/`);
});

test('relative feed publication labels remain anchored to their capture, not processing time', () => {
 const articles = parseArticleFeed('<rss><channel><item><link>/relative-story</link><pubDate>২ ঘণ্টা আগে</pubDate></item></channel></rss>', base, observed);
 const delayed = resolvePublication(articles[0].dateEvidence, { observedAt: new Date('2026-10-12T08:00:00Z'), timeZone: 'Asia/Dhaka' });
 assert.equal(delayed.publishedAt?.toISOString(), '2026-10-11T06:00:00.000Z');
 assert.equal(delayed.confidence, 'verified');
 assert.equal(articles[0].dateEvidence[0].observedAt, observed);
});

test('collector fetches sitemap children sequentially and deduplicates cyclic endpoint discovery', async () => {
 const calls: string[] = [];
 let active = 0, maximumActive = 0;
 const pages = {
  [`${base}/index.xml`]: indexMap([`${base}/first.xml`, `${base}/second.xml`, `${base}/index.xml`]),
  [`${base}/first.xml`]: sitemapItems(2),
  [`${base}/second.xml`]: sitemapItems(2, 1),
 };
 const source = fetcher(pages, calls);
 const sequential: PageFetcher = async (url, signal) => {
  active++; maximumActive = Math.max(maximumActive, active);
  try { await setImmediate(); return await source(url, signal); } finally { active--; }
 };
 const before = Date.now();
 const articles = await collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/index.xml` }] }, sequential);
 const after = Date.now();
 assert.equal(maximumActive, 1);
 assert.deepEqual(calls, [`${base}/index.xml`, `${base}/first.xml`, `${base}/second.xml`]);
 assert.deepEqual(articles.map(article => article.url), [`${base}/story-0`, `${base}/story-1`, `${base}/story-2`]);
 assert.ok(articles.every(article => article.discoveredAt.getTime() >= before && article.discoveredAt.getTime() <= after));
});

test('duplicate feed discoveries preserve existing publication evidence when the last endpoint is undated', async () => {
 const dated = '<rss><channel><item><link>/duplicate</link><pubDate>2026-10-11T12:00:00+06:00</pubDate></item></channel></rss>';
 const undated = '<feed><entry><link href="/duplicate"/><updated>2026-10-12T12:00:00+06:00</updated></entry></feed>';
 const articles = await collectArticleLinks({ method: 'rss', endpoints: [
  { kind: 'rss', url: `${base}/first-feed` }, { kind: 'rss', url: `${base}/second-feed` },
 ] }, fetcher({ [`${base}/first-feed`]: dated, [`${base}/second-feed`]: undated }, []));
 assert.equal(articles.length, 1);
 assert.equal(articles[0].dateEvidence.length, 1);
 assert.equal(articles[0].dateEvidence[0].raw, '2026-10-11T12:00:00+06:00');
 assert.ok(articles[0].discoveredAt.getTime() <= articles[0].dateEvidence[0].observedAt!.getTime());
});

test('sitemap depth and endpoint caps fail visibly with bounded requests', async () => {
 const calls: string[] = [];
 await assert.rejects(collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/root.xml` }] }, fetcher({
  [`${base}/root.xml`]: indexMap([`${base}/one.xml`]),
  [`${base}/one.xml`]: indexMap([`${base}/two.xml`]),
  [`${base}/two.xml`]: indexMap([`${base}/three.xml`]),
  [`${base}/three.xml`]: sitemapItems(1),
 }, calls)), /depth capped at 2/);
 assert.deepEqual(calls, [`${base}/root.xml`, `${base}/one.xml`, `${base}/two.xml`]);
 const endpoints = Array.from({ length: 21 }, (_, index) => `${base}/map-${index}.xml`);
 const pages = Object.fromEntries(endpoints.map(url => [url, sitemapItems(0)]));
 pages[`${base}/many.xml`] = indexMap(endpoints);
 const cappedCalls: string[] = [];
 await assert.rejects(collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/many.xml` }] }, fetcher(pages, cappedCalls)), /capped at 20 endpoints/);
 assert.equal(cappedCalls.length, 20);
});

test('twenty unique discovery requests still succeed when pending endpoints contain duplicates', async () => {
 const urls = Array.from({ length: 20 }, (_, index) => `${base}/feed-${index}`);
 const calls: string[] = [];
 const articles = await collectArticleLinks({ method: 'rss', endpoints: [...urls, urls[0]].map(url => ({ kind: 'rss', url })) },
  fetcher(Object.fromEntries(urls.map(url => [url, rssItems(0)])), calls));
 assert.equal(articles.length, 0);
 assert.equal(calls.length, 20);
});

test('per-document and aggregate article caps report incomplete coverage instead of truncating', async () => {
 assert.equal(parseArticleFeed(rssItems(MAX_COLLECTION_ARTICLES), base, observed).length, MAX_COLLECTION_ARTICLES);
 assert.throws(() => parseArticleFeed(rssItems(MAX_COLLECTION_ARTICLES + 1), base, observed), /exceeds 1000 articles/);
 assert.throws(() => parseArticleSitemap(sitemapItems(MAX_COLLECTION_ARTICLES + 1), base, observed), /exceeds 1000 articles/);
 const calls: string[] = [];
 await assert.rejects(collectArticleLinks({ method: 'rss', endpoints: [
  { kind: 'rss', url: `${base}/one` }, { kind: 'rss', url: `${base}/two` },
 ] }, fetcher({ [`${base}/one`]: rssItems(600), [`${base}/two`]: rssItems(401, 600) }, calls)), /capped at 1000 articles/);
 assert.equal(calls.length, 2);
});

test('unsupported/missing discovery endpoints, malformed documents and fetch errors remain errors', async () => {
 const unused: PageFetcher = async () => { throw new Error('Should not fetch'); };
 await assert.rejects(collectArticleLinks({ method: 'listing', endpoints: [] }, unused), /deferred to slice 5/);
 await assert.rejects(collectArticleLinks({ method: 'rss', endpoints: [{ kind: 'sitemap', url: `${base}/map.xml` }] }, unused), /No discovery endpoint/);
 assert.throws(() => parseArticleFeed('<html>Not XML feed</html>', base, observed), /Not an RSS\/Atom/);
 assert.throws(() => parseArticleSitemap('<rss/>', base, observed), /Not an XML sitemap/);
 await assert.rejects(collectArticleLinks({ method: 'rss', endpoints: [{ kind: 'rss', url: `${base}/broken` }] }, fetcher({}, [])), /HTTP 404/);
 const blocked = '<!DOCTYPE rss [<!ENTITY exploit SYSTEM "file:///etc/passwd">]><rss><channel/></rss>';
 assert.throws(() => parseArticleFeed(blocked, base, observed), /declarations\/entities/);
 assert.throws(() => parseArticleSitemap('<!ENTITY exploit "payload"><urlset/>', base, observed), /declarations\/entities/);
 const stop = new AbortController(); stop.abort(new Error('Stopped by operator'));
 await assert.rejects(collectArticleLinks({ method: 'rss', endpoints: [{ kind: 'rss', url: `${base}/rss` }] }, unused, stop.signal), /Stopped by operator/);
});
