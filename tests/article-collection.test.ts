import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { collectArticleLinks, MAX_COLLECTION_ARTICLES, parseArticleFeed, parseArticleSitemap, parseArticleListing } from '../packages/domain/src/article-collection';
import { MAX_SITE_CANDIDATES_PER_SCAN } from '../packages/domain/src/article-candidates';
import { canonicalizeArticleUrl } from '../packages/domain/src/article-urls';
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
 assert.deepEqual(result.discoveries.find(entry=>entry.url.endsWith('/news-story'))!.dateEvidence, [{ raw: '2026-10-11T12:00:00+06:00', source: 'news-sitemap', observedAt: observed }]);
 assert.deepEqual(result.discoveries.find(entry=>entry.url.endsWith('/regular-story'))!.dateEvidence, []);
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
 const articles = await collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/index.xml` }] }, sequential,undefined,{observedAt:new Date()});
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

test('sitemap depth protection remains while endpoint caps limit coverage with bounded requests', async () => {
 const calls: string[] = [];
 await assert.rejects(collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/root.xml` }] }, fetcher({
  [`${base}/root.xml`]: indexMap([`${base}/one.xml`]),
  [`${base}/one.xml`]: indexMap([`${base}/two.xml`]),
  [`${base}/two.xml`]: indexMap([`${base}/three.xml`]),
  [`${base}/three.xml`]: sitemapItems(1),
 }, calls)),/depth capped at 2/);
 assert.deepEqual(calls, [`${base}/root.xml`, `${base}/one.xml`, `${base}/two.xml`]);
 const endpoints = Array.from({ length: 21 }, (_, index) => `${base}/map-${index}.xml`);
 const pages = Object.fromEntries(endpoints.map(url => [url, sitemapItems(0)]));
 pages[`${base}/many.xml`] = indexMap(endpoints);
 const cappedCalls: string[] = [];
 const cappedDiagnostics:string[]=[];
 assert.deepEqual(await collectArticleLinks({ method: 'sitemap', endpoints: [{ kind: 'sitemap', url: `${base}/many.xml` }] }, fetcher(pages, cappedCalls),undefined,{diagnostics:cappedDiagnostics}),[]);
 assert.ok(cappedDiagnostics.some(message=>message.includes('20 highest-priority')));
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

test('feed caps still fail visibly while large sitemaps keep their newest entries', async () => {
 assert.equal(parseArticleFeed(rssItems(MAX_COLLECTION_ARTICLES), base, observed).length, MAX_COLLECTION_ARTICLES);
 assert.throws(() => parseArticleFeed(rssItems(MAX_COLLECTION_ARTICLES + 1), base, observed), /exceeds 1000 articles/);
 const count=MAX_COLLECTION_ARTICLES+1;
 // Sub-millisecond publication differences must still select the newest N.
 const dates=Array.from({length:count},(_,index)=>observed.toISOString().replace(/\.\d{3}Z$/,`.${String(index).padStart(6,'0')}Z`));
 const large=`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${dates.map((date,index)=>`<url><loc>${base}/story-${index}</loc><news:news><news:publication_date>${date}</news:publication_date></news:news><lastmod>2099-01-01T00:00:00Z</lastmod></url>`).join('')}</urlset>`;
 const result=parseArticleSitemap(large,base,observed);
 assert.equal(result.discoveries.length,MAX_COLLECTION_ARTICLES);
 assert.equal(result.discoveries[0].url,`${base}/story-${count-1}`);
 assert.ok(!result.discoveries.some(entry=>entry.url===`${base}/story-0`));
 assert.ok(result.diagnostics.some(message=>/Coverage limited/.test(message)));
 assert.equal(result.discoveries[0].dateEvidence[0].raw,dates[count-1]);
 const calls: string[] = [];
 await assert.rejects(collectArticleLinks({ method: 'rss', endpoints: [
  { kind: 'rss', url: `${base}/one` }, { kind: 'rss', url: `${base}/two` },
 ] }, fetcher({ [`${base}/one`]: rssItems(600), [`${base}/two`]: rssItems(401, 600) }, calls)), /capped at 1000 articles/);
 assert.equal(calls.length, 2);
});

test('sitemap lastmod orders undated entries without becoming publication evidence', () => {
 const result=parseArticleSitemap(`<urlset>
  <url><loc>${base}/old</loc><lastmod>2026-10-10T00:00:00Z</lastmod></url>
  <url><loc>${base}/unknown</loc><lastmod>not-a-date</lastmod></url>
  <url><loc>${base}/new</loc><lastmod>2026-10-12T00:00:00Z</lastmod></url>
 </urlset>`,base,observed);
 assert.deepEqual(result.discoveries.map(entry=>entry.url),[`${base}/new`,`${base}/old`,`${base}/unknown`]);
 assert.ok(result.discoveries.every(entry=>entry.dateEvidence.length===0));
});

test('large sitemap indexes read newest children first and keep global newest N entries', async()=> {
 const count=MAX_COLLECTION_ARTICLES+1;
 const childUrls=Array.from({length:count},(_,index)=>`${base}/archive-${index}.xml`);
 const index=`<sitemapindex>${childUrls.map((url,index)=>`<sitemap><loc>${url}</loc><lastmod>${new Date(observed.getTime()+index*1000).toISOString()}</lastmod></sitemap>`).join('')}</sitemapindex>`;
 const calls:string[]=[],diagnostics:string[]=[];
 const pages:Record<string,string>={[`${base}/index.xml`]:index};
 for(const [index,url]of childUrls.entries())pages[url]=`<urlset>${Array.from({length:60},(_,item)=>`<url><loc>${base}/story-${index}-${item}</loc><lastmod>${new Date(observed.getTime()+index*60000+item*1000).toISOString()}</lastmod></url>`).join('')}</urlset>`;
 const articles=await collectArticleLinks({method:'sitemap',endpoints:[{kind:'sitemap',url:`${base}/index.xml`}]},fetcher(pages,calls),undefined,{diagnostics,observedAt:observed});
 assert.equal(calls.length,20);
 assert.equal(calls[1],childUrls[count-1]);
 assert.equal(calls[19],childUrls[count-19]);
 assert.equal(articles.length,MAX_SITE_CANDIDATES_PER_SCAN);
 assert.equal(articles[0].url,`${base}/story-${count-1}-59`);
 assert.ok(articles.every(article=>article.dateEvidence.length===0));
 assert.ok(diagnostics.some(message=>message.includes('20 highest-priority')));
 assert.ok(diagnostics.some(message=>message.includes('newest 1000')));
});

test('declared news sitemap takes precedence over newer archive child maps', async()=> {
 const calls:string[]=[],diagnostics:string[]=[];
 const index=`<sitemapindex><sitemap><loc>${base}/archive.xml</loc><lastmod>2026-10-12T00:00:00Z</lastmod></sitemap><sitemap><loc>${base}/news-sitemap.xml</loc><lastmod>2026-10-11T00:00:00Z</lastmod></sitemap></sitemapindex>`;
 const articles=await collectArticleLinks({method:'sitemap',endpoints:[{kind:'sitemap',url:`${base}/index.xml`}]},fetcher({
  [`${base}/index.xml`]:index,[`${base}/news-sitemap.xml`]:await fixture('news-sitemap.xml'),[`${base}/archive.xml`]:sitemapItems(1001)
 },calls),undefined,{diagnostics});
 assert.equal(articles.length,2);
 assert.deepEqual(calls,[`${base}/index.xml`,`${base}/news-sitemap.xml`]);
 assert.ok(diagnostics.some(message=>message.includes('preferred the news sitemap')));
});

test('unsupported/missing discovery endpoints, malformed documents and fetch errors remain errors', async () => {
 const unused: PageFetcher = async () => { throw new Error('Should not fetch'); };
 await assert.rejects(collectArticleLinks({ method: 'listing', endpoints: [] }, unused), /No discovery endpoint/);
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

test('listing scans fetch primary/additional URLs and bounded section/pagination depth on every scan',async()=>{
 const pages={
  [`${base}/latest`]:`<div><a href="/post/123/new-story">Story</a><a href="/known-story?utm_source=listing">Known</a>
   <a href="/category/news">Section</a><a href="/latest?page=2">Next</a><a href="${base}/">Home</a>
   <a href="/tag/brand">Tag</a><a href="/archive/2021">Archive</a><a href="/print/123">Print</a>
   <a href="/?s=brand">Search</a><a href="https://other.example.com/post/456">External</a></div>`,
  [`${base}/business`]:`<article><a href="/business/456/second-story">Story two</a><time datetime="2026-10-11T07:00:00Z"></time></article>`,
  [`${base}/category/news`]:`<a href="/post/789/section-story">Section story</a><a href="/category/deeper">Deeper</a>`,
  [`${base}/latest?page=2`]:`<a href="/post/999/page-story">Next story</a><a href="/latest?page=3">Next</a>`,
 };
 const site={url:base,method:'listing',listing_url:`${base}/latest`,scan_depth:1,endpoints:[{kind:'listing' as const,url:`${base}/business`}]};
 for(let scan=0;scan<2;scan++) {
  const calls:string[]=[],links=await collectArticleLinks(site,fetcher(pages,calls),undefined,{knownUrls:[`${base}/known-story`],observedAt:observed});
  assert.deepEqual(calls,[`${base}/latest`,`${base}/business`,`${base}/category/news`,`${base}/latest?page=2`]);
  assert.deepEqual(new Set(links.map(link=>link.url)),new Set([`${base}/post/123/new-story`,`${base}/business/456/second-story`,`${base}/post/789/section-story`,`${base}/post/999/page-story`]));
  assert.ok(links.every(link=>link.source==='listing'));
  assert.equal(links[0].url,`${base}/business/456/second-story`);
  assert.deepEqual(links[0].dateEvidence,[{raw:'2026-10-11T07:00:00Z',source:'time',observedAt:observed}]);
 }
 const calls:string[]=[];
 await collectArticleLinks({...site,scan_depth:0},fetcher(pages,calls),undefined,{observedAt:observed});
 assert.deepEqual(calls,[`${base}/latest`,`${base}/business`]);
});

test('RSS scans also collect every supplied listing, retain provenance, and omit navigation URLs',async()=>{
 const calls:string[]=[],rss=`<rss><channel>
  <item><link>/new-story</link><pubDate>2026-10-11T07:30:00Z</pubDate></item>
  ${['/','/category/news','/tag/brand','/archive/2021','/print/123','/?s=brand','/latest?page=2','https://other.example.com/post/1'].map(url=>`<item><link>${url.replace('&','&amp;')}</link><pubDate>2026-10-11T07:30:00Z</pubDate></item>`).join('')}
 </channel></rss>`;
 const links=await collectArticleLinks({url:base,method:'rss',listing_url:`${base}/latest`,scan_depth:0,endpoints:[
  {kind:'rss',url:`${base}/feed`},{kind:'listing',url:`${base}/business`}
 ]},fetcher({[`${base}/feed`]:rss,[`${base}/latest`]:'<a href="/new-story?utm_source=listing">Same story</a><a href="/listing-only">Listing story</a>',
  [`${base}/business`]:'<a href="/business-only">Business story</a>'},calls),undefined,{observedAt:observed});
 assert.deepEqual(calls,[`${base}/feed`,`${base}/latest`,`${base}/business`]);
 assert.deepEqual(links.map(link=>[canonicalizeArticleUrl(link.url),link.source]),[
  [`${base}/new-story`,'rss'],[`${base}/new-story`,'listing'],[`${base}/listing-only`,'listing'],[`${base}/business-only`,'listing']
 ]);
});

test('listing evidence ignores modified times and sorts publication before discovery',async()=>{
 const calls:string[]=[],pages={
  [`${base}/latest`]:`<article><a href="/old-story">Old</a><time datetime="2026-10-10T00:00:00Z"></time></article>
   <article><a href="/updated-only">Modified</a><time itemprop="dateModified" datetime="2099-01-01T00:00:00Z"></time></article>`,
  [`${base}/extra`]:`<article><a href="/new-story">New</a><time datetime="2026-10-11T07:00:00Z"></time></article>
   <a href="/discovered-later">Undated</a>`,
 };
 const source=fetcher(pages,calls),delayed:PageFetcher=async(url,signal)=>{await new Promise(resolve=>setTimeout(resolve,3));return source(url,signal);};
 const links=await collectArticleLinks({url:base,method:'listing',endpoints:[{kind:'listing',url:`${base}/latest`},{kind:'listing',url:`${base}/extra`}]},delayed);
 assert.deepEqual(links.map(link=>link.url),[`${base}/new-story`,`${base}/old-story`,`${base}/discovered-later`,`${base}/updated-only`]);
 assert.equal(links.find(link=>link.url.endsWith('/updated-only'))!.dateEvidence.length,0);
});

test('one site adds at most 100 newest unknown URL identities across feeds and listings',async()=>{
 const count=150,calls:string[]=[],diagnostics:string[]=[];
 const rss=`<rss><channel>${Array.from({length:count},(_,index)=>`<item><link>/story-${index}</link><pubDate>${new Date(observed.getTime()-count*60000+index*60000).toISOString()}</pubDate></item>`).join('')}</channel></rss>`;
 const listing=Array.from({length:count},(_,index)=>`<a href="/story-${index}">Story ${index}</a>`).join('');
 const links=await collectArticleLinks({url:base,method:'rss',listing_url:`${base}/latest`,endpoints:[{kind:'rss',url:`${base}/feed`}]},fetcher({
  [`${base}/feed`]:rss,[`${base}/latest`]:listing,
 },calls),undefined,{diagnostics,observedAt:observed,knownUrls:[`${base}/story-149`]});
 const unknown=links.filter(link=>!link.url.endsWith('/story-149'));
 assert.equal(new Set(unknown.map(link=>canonicalizeArticleUrl(link.url))).size,100);
 assert.equal(links[0].url,`${base}/story-149`); // Known feed evidence is still reconciled against stored content.
 assert.equal(links[1].url,`${base}/story-148`);
 assert.ok(unknown.every(link=>Number(link.url.match(/story-(\d+)/)![1])>=49));
 assert.ok(diagnostics.some(message=>message.includes('100 new article URLs')));
});

test('old RSS and sitemap sources are marked stale and supplied listing pages take priority',async()=>{
 for(const method of ['rss','sitemap'] as const) {
  const calls:string[]=[],diagnostics:string[]=[],url=`${base}/source.xml`;
  const body=method==='rss'?'<rss><channel><item><link>/old-story</link><pubDate>2021-01-01T00:00:00Z</pubDate></item></channel></rss>'
   :`<urlset><url><loc>${base}/old-story</loc><lastmod>2019-01-01T00:00:00Z</lastmod></url></urlset>`;
  const links=await collectArticleLinks({url:base,method,listing_url:`${base}/latest`,endpoints:[{kind:method,url}]},fetcher({[url]:body,[`${base}/latest`]:'<a href="/current-story">Current</a>'},calls),undefined,{diagnostics,observedAt:observed});
  assert.deepEqual(calls,[url,`${base}/latest`]);
  assert.deepEqual(links.map(link=>link.url),[`${base}/current-story`]);
  assert.ok(diagnostics.some(message=>message.includes(`${url}: Source is stale`)));
  assert.ok(diagnostics.some(message=>message.includes('Preferred supplied listing')));
 }
});

test('fresh sitemap lastmod establishes source health only and listing failures retain source results',async()=>{
 const diagnostics:string[]=[];
 const links=await collectArticleLinks({url:base,method:'sitemap',listing_url:`${base}/missing`,endpoints:[{kind:'sitemap',url:`${base}/map.xml`}]},fetcher({
  [`${base}/map.xml`]:`<urlset><url><loc>${base}/current-story</loc><lastmod>${observed.toISOString()}</lastmod></url></urlset>`,
 },[]),undefined,{diagnostics,observedAt:observed});
 assert.equal(links.length,1);assert.deepEqual(links[0].dateEvidence,[]);
 assert.ok(!diagnostics.some(message=>message.includes('stale')));
 assert.ok(diagnostics.some(message=>message.includes('HTTP 404')));
});

test('listing collection falls back from failed feeds, bounds requests, and rejects external redirects',async()=>{
 const pages:Record<string,string>={[`${base}/latest`]:Array.from({length:30},(_,index)=>`<a href="/category/section-${index}">Section</a>`).join('')};
 for(let index=0;index<30;index++)pages[`${base}/category/section-${index}`]=`<a href="/post/${index}/article">Story</a>`;
 const calls:string[]=[],diagnostics:string[]=[];
 const links=await collectArticleLinks({url:base,method:'rss',listing_url:`${base}/latest`,scan_depth:2,endpoints:[{kind:'rss',url:`${base}/missing-feed`}]},fetcher(pages,calls),undefined,{diagnostics});
 assert.equal(calls.length,21); // One failed source, then the bounded twenty listing requests.
 assert.equal(links.length,19);assert.ok(diagnostics.some(message=>message.includes('20 listing pages')));
 await assert.rejects(collectArticleLinks({url:base,method:'listing',listing_url:`${base}/latest`,endpoints:[]},async()=>({url:'https://other.example.com/latest',body:'<a href="/new-story">Story</a>',contentType:'text/html'})),/outside the site host/);
 const stop=new AbortController();stop.abort(new Error('Stopped'));
 await assert.rejects(collectArticleLinks({url:base,method:'listing',listing_url:`${base}/latest`,endpoints:[]},fetcher(pages,[]),stop.signal),/Stopped/);
});

test('listing parser accepts Bangla article slugs and WordPress IDs while excluding roots and print/search variants',()=>{
 const paths=['/বাংলাদেশ/নতুন-সংবাদ','/?p=123','/','/index.html','/world','/tag/news','/archive/2026','/news/story?print=1','/news/story?output=print','/search?q=brand'];
 const links=parseArticleListing(paths.map(path=>`<a href="${path}">Story</a>`).join(''),base,base,observed);
 assert.deepEqual(links.map(link=>decodeURI(link.url)),[`${base}/বাংলাদেশ/নতুন-সংবাদ`,`${base}/?p=123`]);
});

test('listing depth follows section pages without fetching article-shaped news URLs as listings',async()=>{
 const calls:string[]=[],links=await collectArticleLinks({url:base,method:'listing',listing_url:`${base}/latest`,scan_depth:2,endpoints:[]},fetcher({
  [`${base}/latest`]:'<a href="/news/article-123">Article</a><a href="/news">News section</a>',
  [`${base}/news`]:'<a href="/news/article-456">Article</a>',
 },calls));
 assert.deepEqual(calls,[`${base}/latest`,`${base}/news`]);
 assert.deepEqual(new Set(links.map(link=>link.url)),new Set([`${base}/news/article-123`,`${base}/news/article-456`]));
});
