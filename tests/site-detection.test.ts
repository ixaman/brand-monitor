import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectSite, feedPreview, sitemapPreview, listingPreview, xmlDocument, MAX_DETECTION_REQUESTS } from '../packages/domain/src/site-detection';
import type { PageFetcher } from '../packages/domain/src/safe-http';
import { assessSourceFreshness } from '../packages/domain/src/source-freshness';
const fixture = (name: string) => readFile(new URL(`./fixtures/sites/${name}`,import.meta.url),'utf8');
const base = 'https://news.example.com';
const input = {url:base,listing_url:null,scan_depth:1,endpoints:[]};
function fetcher(pages: Record<string,string>, calls: string[]): PageFetcher {
 return async url => { calls.push(url); if (!(url in pages)) throw new Error('HTTP 404'); return {url,body:pages[url],contentType:'text/html'}; };
}
test('RSS/Atom fixtures preserve Bangla titles and publication evidence; sitemap lastmod stays modified', async () => {
 const rss = feedPreview(await fixture('rss.xml'),base);
 assert.equal(rss.length,2);
 assert.equal(rss[0].url,base+'/story-two');
 assert.equal(rss[1].title,'ব্র্যান্ডের নতুন খবর');
 const atom = feedPreview(await fixture('atom.xml'),base)[0];
 assert.equal(atom.url,base+'/atom-story');
 assert.equal(atom.raw_date,'2026-10-11T08:00:00+06:00');
 const sitemap = sitemapPreview(await fixture('news-sitemap.xml'),base);
 assert.equal(sitemap.posts.find(post=>post.url.endsWith('/news-story'))?.date_kind,'publication');
 assert.equal(sitemap.posts.find(post=>post.url.endsWith('/regular-story'))?.date_kind,'modified');
 assert.throws(()=>xmlDocument('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><rss/>'));
});
test('listing fixture excludes navigation/external/private links and includes date evidence', async () => {
 const posts = listingPreview(await fixture('listing.html'),base);
 assert.deepEqual(posts.map(post=>post.url),[base+'/latest-story',base+'/second-story']);
 assert.equal(posts[0].raw_date,'2026-10-11T12:30:00+06:00');
});
test('detection prefers advertised RSS over sitemap and listing', async () => {
 const calls: string[]=[];
 const result = await detectSite(input,fetcher({[base]:await fixture('listing.html'),[base+'/feed.xml']:await fixture('rss.xml')},calls));
 assert.equal(result.method,'rss'); assert.equal(result.status,'ready');
 assert.deepEqual(calls,[base,base+'/feed.xml']);
 assert.equal(result.preview.length,2);
});
test('RSS failures fall back to sitemap index/news sitemap before listing', async () => {
 const calls: string[]=[];
 const result = await detectSite(input,fetcher({[base]:await fixture('listing.html'),[base+'/robots.txt']:'Sitemap: '+base+'/sitemap.xml',[base+'/sitemap.xml']:await fixture('sitemap-index.xml'),[base+'/news-map.xml']:await fixture('news-sitemap.xml')},calls));
 assert.equal(result.method,'sitemap');
 assert.equal(result.endpoints[0].url,base+'/news-map.xml');
 assert.ok(calls.indexOf(base+'/feed.xml')<calls.indexOf(base+'/sitemap.xml'));
 assert.ok(result.diagnostics.some(message=>message.includes('404')));
});
test('configured listing fallback and section crawl respect depth and caps', async () => {
 const calls: string[]=[];
 const result = await detectSite({...input,listing_url:base+'/latest'},fetcher({[base]:'<a href="/category/news">News</a>',[base+'/latest']:await fixture('listing.html')},calls));
 assert.equal(result.method,'listing'); assert.equal(result.endpoints[0].url,base+'/latest');
 const pages = {[base]:'<a href="/category/news">News</a>',[base+'/category/news']:await fixture('listing.html')};
 const shallowCalls: string[]=[];
 assert.equal((await detectSite({...input,scan_depth:0},fetcher(pages,shallowCalls))).status,'needs_attention');
 assert.ok(!shallowCalls.includes(base+'/category/news'));
 const deepCalls: string[]=[];
 assert.equal((await detectSite(input,fetcher(pages,deepCalls))).method,'listing');
 assert.ok(deepCalls.length<=MAX_DETECTION_REQUESTS);
});
test('timeout, CAPTCHA, malformed feeds and empty sites return attention without throwing', async () => {
 const never: PageFetcher = (_url,signal) => new Promise((_resolve,reject) => {
  const timer = setTimeout(()=>reject(new Error('Fixture request stalled')),1000);
  signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
 });
 const start = Date.now();
 const timeout = await detectSite(input,never,{timeoutMs:25});
 assert.equal(timeout.status,'needs_attention');
 assert.ok(Date.now()-start<1000);
 const blocked = await detectSite(input,fetcher({[base]:'<html>Verify you are human CAPTCHA</html>'},[]));
 assert.equal(blocked.method,'extension'); assert.equal(blocked.status,'needs_attention');
 const empty = await detectSite(input,fetcher({[base]:'<html></html>',[base+'/feed']:'<rss><channel></channel></rss>'},[]));
 assert.equal(empty.status,'needs_attention'); assert.equal(empty.preview.length,0);
});
test('cyclic sitemap and listing discoveries have bounded requests', async () => {
 const calls: string[]=[];
 const result = await detectSite(input,fetcher({[base]:'<a href="/category/news">News</a>',[base+'/category/news']:'<a href="/category/news">News</a>',[base+'/sitemap.xml']:`<sitemapindex><sitemap><loc>${base}/sitemap.xml</loc></sitemap></sitemapindex>`},calls));
 assert.equal(result.status,'needs_attention');
 assert.ok(calls.length<=MAX_DETECTION_REQUESTS);
 assert.equal(calls.filter(url=>url===base+'/sitemap.xml').length,1);
});
test('oldest-first sitemap preview sorts every entry before its preview cap, including URLs after position 200',()=>{
 const old = Array.from({length:250},(_entry,index)=>`<url><loc>${base}/archive-${index}</loc><lastmod>2020-01-01T00:00:00Z</lastmod></url>`).join('');
 const parsed = sitemapPreview(`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${old}<url><loc>${base}/latest-news-story</loc><news:news><news:title>সাম্প্রতিক সংবাদ</news:title><news:publication_date>2026-10-12T01:30:00+06:00</news:publication_date></news:news><lastmod>2020-01-01</lastmod></url></urlset>`,base);
 assert.equal(parsed.posts.length,8);
 assert.equal(parsed.posts[0].url,base+'/latest-news-story');
 assert.equal(parsed.posts[0].date_kind,'publication');
 assert.equal(parsed.posts[0].raw_date,'2026-10-12T01:30:00+06:00');
 assert.ok(parsed.diagnostics.some(message=>message.includes('Coverage limited')&&message.includes('251')));
});
test('sitemap sorting prefers each valid publication over its modification, using lastmod only as ordering fallback',()=>{
 const entries = [
  `<url><loc>${base}/older-published</loc><news:news><news:publication_date>2026-10-10T12:00:00Z</news:publication_date></news:news><lastmod>2027-01-01</lastmod></url>`,
  `<url><loc>${base}/unknown</loc><lastmod>invalid</lastmod></url>`,
  `<url><loc>${base}/newer-published</loc><news:news><news:publication_date>2026-10-11T12:00:00Z</news:publication_date></news:news><lastmod>2020-01-01</lastmod></url>`,
  `<url><loc>${base}/invalid-publication</loc><news:news><news:publication_date>bad publication date</news:publication_date></news:news><lastmod>2026-10-11T13:00:00Z</lastmod></url>`,
 ];
 const parsed = sitemapPreview(`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${entries.join('')}</urlset>`,base);
 assert.deepEqual(parsed.posts.map(post=>post.url),['/invalid-publication','/newer-published','/older-published','/unknown'].map(path=>base+path));
 // Fallback lastmod affects queue order, never changes publication evidence.
 assert.equal(parsed.posts[0].raw_date,'bad publication date');
 assert.equal(parsed.posts[0].date_kind,'publication');
});
test('sitemap index children prioritize news and newest lastmod before the first-20 cap',()=>{
 const archive = Array.from({length:25},(_entry,index)=>`<sitemap><loc>${base}/archive-${index}.xml</loc><lastmod>2020-01-01</lastmod></sitemap>`).join('');
 const parsed = sitemapPreview(`<sitemapindex>${archive}<sitemap><loc>${base}/recent-posts.xml</loc><lastmod>2026-10-11T15:00:00Z</lastmod></sitemap><sitemap><loc>${base}/news-sitemap.xml</loc><lastmod>2025-01-01</lastmod></sitemap></sitemapindex>`,base);
 assert.equal(parsed.children.length,20);
 assert.deepEqual(parsed.children.slice(0,2),[base+'/news-sitemap.xml',base+'/recent-posts.xml']);
 assert.ok(parsed.diagnostics.some(message=>message.includes('Coverage limited')&&message.includes('27')));
});
test('detection selects declared news sitemaps before configured generic archives without speculative news probes',async()=>{
 const calls: string[] = [];
 const result = await detectSite({...input,endpoints:[{kind:'sitemap' as const,url:base+'/old-archive.xml'}]},fetcher({
  [base]:'<link rel="sitemap" href="/news-sitemap.xml">',
  [base+'/robots.txt']:'Sitemap: '+base+'/old-archive.xml',
  [base+'/news-sitemap.xml']:`<urlset><url><loc>${base}/today</loc><lastmod>2026-10-11T14:00:00Z</lastmod></url></urlset>`,
  [base+'/old-archive.xml']:`<urlset><url><loc>${base}/old</loc><lastmod>2020-01-01</lastmod></url></urlset>`,
 },calls));
 assert.equal(result.endpoints[0].url,base+'/news-sitemap.xml');
 assert.ok(!calls.includes(base+'/old-archive.xml'));
 assert.ok(!calls.includes(base+'/sitemap.xml'));
});
test('robots-declared news sitemap wins even when generic endpoints occur earlier and selection is bounded',async()=>{
 const calls: string[] = [];
 const generic = Array.from({length:5},(_entry,index)=>`${base}/archive-${index}.xml`);
 const result = await detectSite(input,fetcher({
  [base]:'<html></html>',[base+'/robots.txt']:[...generic,base+'/news-sitemap.xml'].map(url=>'Sitemap: '+url).join('\n'),
  [base+'/news-sitemap.xml']:`<urlset><url><loc>${base}/today</loc><lastmod>2026-10-11T14:00:00Z</lastmod></url></urlset>`,
 },calls));
 assert.equal(result.endpoints[0].url,base+'/news-sitemap.xml');
 assert.ok(generic.every(url=>!calls.includes(url)));
 assert.ok(result.diagnostics.some(message=>message.includes('Coverage limited')&&message.includes('sitemap endpoints')));
});
test('detection follows index news/newest children before generic fallback and keeps preview limit diagnostics',async()=>{
 const calls: string[] = [];
 const archive = Array.from({length:5},(_entry,index)=>`<sitemap><loc>${base}/archive-${index}.xml</loc><lastmod>2020-01-01</lastmod></sitemap>`).join('');
 const oldEntries = Array.from({length:250},(_entry,index)=>`<url><loc>${base}/old-${index}</loc><lastmod>2020-01-01</lastmod></url>`).join('');
 const result = await detectSite({...input,endpoints:[{kind:'sitemap' as const,url:base+'/index.xml'}]},fetcher({
  [base]:'<html></html>',[base+'/robots.txt']:'',
  [base+'/index.xml']:`<sitemapindex>${archive}<sitemap><loc>${base}/recent-posts.xml</loc><lastmod>2026-10-11T14:00:00Z</lastmod></sitemap><sitemap><loc>${base}/news-sitemap.xml</loc><lastmod>2025-01-01</lastmod></sitemap></sitemapindex>`,
  [base+'/news-sitemap.xml']:`<urlset>${oldEntries}<url><loc>${base}/latest-story</loc><lastmod>2026-10-11T14:00:00Z</lastmod></url></urlset>`,
  [base+'/sitemap.xml']:`<urlset><url><loc>${base}/generic-old</loc><lastmod>2020-01-01</lastmod></url></urlset>`,
 },calls));
 assert.equal(result.endpoints[0].url,base+'/news-sitemap.xml');
 assert.equal(result.preview[0].url,base+'/latest-story');
 assert.ok(!calls.includes(base+'/sitemap.xml'));
 assert.ok(result.diagnostics.some(message=>message.includes('Coverage limited')&&message.includes('child maps')));
 assert.ok(result.diagnostics.some(message=>message.includes('Coverage limited')&&message.includes('251')));
 assert.ok(calls.length<=MAX_DETECTION_REQUESTS);
});
test('source freshness includes the exact seven-day boundary and excludes old, invalid, absent and future evidence',()=>{
 const observedAt = new Date('2026-10-12T12:00:00Z');
 const freshness = (entries: Parameters<typeof assessSourceFreshness>[0]) => assessSourceFreshness(entries,{observedAt});
 assert.equal(freshness([{published:'2026-10-05T12:00:00Z'}]).state,'fresh');
 assert.equal(freshness([{published:'2026-10-05T11:59:59.999999Z'}]).state,'stale');
 assert.equal(freshness([{published:'2026-10-12T12:00:00.000001Z'}]).state,'stale');
 assert.equal(freshness([{published:'not a date'}]).state,'stale');
 assert.equal(freshness([{}]).state,'stale');
 assert.equal(freshness([]).state,'stale');
 // Generic lastmod is allowed only for source health, not article publication.
 assert.equal(freshness([{modified:'2026-10-11T12:00:00Z'}]).state,'fresh');
 assert.equal(freshness([{published:'2020-01-01',modified:'2026-10-11T12:00:00Z'}]).state,'stale');
 assert.equal(freshness([{published:'invalid',modified:'2026-10-11T12:00:00Z'}]).state,'fresh');
 assert.equal(freshness([{published:'২ ঘণ্টা আগে'}]).state,'fresh');
 assert.equal(freshness([{published:'8 days ago'}]).state,'stale');
 assert.match(freshness([{published:'2020-01-01T00:00:00Z'}]).diagnostic,/stale.*2020-01-01/);
});
test('stale historical RSS immediately prefers supplied listing and records detection details',async()=>{
 const calls: string[] = [];
 const result = await detectSite({...input,listing_url:base+'/latest',endpoints:[{kind:'rss',url:base+'/rss.xml'}]},fetcher({
  [base]:'<html></html>',
  [base+'/rss.xml']:`<rss><channel><item><title>TBS historical story</title><link>${base}/historical-story</link><pubDate>2021-01-01T00:00:00Z</pubDate></item></channel></rss>`,
  [base+'/latest']:await fixture('listing.html'),
 },calls),{observedAt:new Date('2026-10-12T12:00:00Z')});
 assert.equal(result.method,'listing');
 assert.equal(result.endpoints[0].url,base+'/latest');
 assert.ok(result.diagnostics.some(message=>message.includes('/rss.xml')&&message.includes('stale')));
 assert.deepEqual(calls,[base,base+'/rss.xml',base+'/latest']);
});
test('stale sitemap prefers configured listing and retains source publication-vs-modification rules',async()=>{
 const calls: string[] = [];
 const result = await detectSite({...input,endpoints:[{kind:'sitemap',url:base+'/sitemap.xml'},{kind:'listing',url:base+'/latest'}]},fetcher({
  [base]:'<html></html>',[base+'/robots.txt']:'',
  [base+'/sitemap.xml']:`<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>${base}/historical-story</loc><news:news><news:publication_date>2021-01-01T00:00:00Z</news:publication_date></news:news><lastmod>2026-10-11T00:00:00Z</lastmod></url></urlset>`,
  [base+'/latest']:await fixture('listing.html'),
 },calls),{observedAt:new Date('2026-10-12T12:00:00Z')});
 assert.equal(result.method,'listing');
 assert.ok(result.diagnostics.some(message=>message.includes('/sitemap.xml')&&message.includes('stale')));
 assert.equal(result.endpoints[0].url,base+'/latest');
});
test('freshness inspects feed entries beyond position 100 before applying the preview cap',async()=>{
 const old = Array.from({length:110},(_entry,index)=>`<item><title>Old story ${index}</title><link>${base}/old-story-${index}</link><pubDate>2020-01-01T00:00:00Z</pubDate></item>`).join('');
 const result = await detectSite(input,fetcher({
  [base]:'<html></html>',
  [base+'/feed']:`<rss><channel>${old}<item><title>Latest story</title><link>${base}/latest-story</link><pubDate>2026-10-12T11:00:00Z</pubDate></item></channel></rss>`,
 },[]),{observedAt:new Date('2026-10-12T12:00:00Z')});
 assert.equal(result.method,'rss');
 assert.equal(result.preview[0].url,base+'/latest-story');
 assert.equal(result.preview.length,8);
 assert.ok(!result.diagnostics.some(message=>message.includes('stale')));
});
test('empty and undated source documents show stale details and prefer supplied listings',async()=>{
 for (const document of ['<rss><channel/></rss>',`<rss><channel><item><title>Unknown publication</title><link>${base}/unknown-date</link></item></channel></rss>`]) {
  const result = await detectSite({...input,listing_url:base+'/latest'},fetcher({
   [base]:'<html></html>',[base+'/feed']:document,[base+'/latest']:await fixture('listing.html'),
  },[]),{observedAt:new Date('2026-10-12T12:00:00Z')});
  assert.equal(result.method,'listing');
  assert.ok(result.diagnostics.some(message=>message.includes('/feed')&&message.includes('stale')));
 }
});
test('previews share queue filtering for homepage, sections, category, tag, archive, print, pagination, search and external links',()=>{
 const excluded = [base,base+'/category/news',base+'/tag/brand',base+'/archive/2026/10',base+'/print/101',base+'/page/2',base+'/search',base+'/?s=brand',base+'/latest',base+'/story?print=1','https://other.example.com/article/123/news-story'];
 const included = base+'/news/article-story';
 const urls = [...excluded,included];
 const rss = `<rss><channel>${urls.map(url=>`<item><title>Article link title</title><link>${url.replaceAll('&','&amp;')}</link><pubDate>2026-10-12T11:00:00Z</pubDate></item>`).join('')}</channel></rss>`;
 const sitemap = `<urlset>${urls.map(url=>`<url><loc>${url.replaceAll('&','&amp;')}</loc><lastmod>2026-10-12T11:00:00Z</lastmod></url>`).join('')}</urlset>`;
 const listing = `<ul>${urls.map(url=>`<li><a href="${url}">Article link title</a></li>`).join('')}</ul>`;
 assert.deepEqual(feedPreview(rss,base).map(post=>post.url),[included]);
 assert.deepEqual(sitemapPreview(sitemap,base).posts.map(post=>post.url),[included]);
 assert.deepEqual(listingPreview(listing,base).map(post=>post.url),[included]);
});
test('plain listing links outside article/main markup support latest pages and ignore modified times',()=>{
 const posts = listingPreview('<nav><a href="/news/nav-story">Navigation story</a></nav><ul><li><a href="/article/282010/current-story">New Age story</a><time class="updated" datetime="2026-10-12T12:00:00Z">Updated</time><time datetime="2026-10-12T11:00:00Z">Published</time></li></ul>',base+'/latest',base);
 assert.deepEqual(posts.map(post=>post.url),[base+'/article/282010/current-story']);
 assert.equal(posts[0].raw_date,'2026-10-12T11:00:00Z');
 assert.equal(posts[0].date_kind,'publication');
});
test('source freshness uses configured timezone and observed relative publication time',async()=>{
 const observedAt = new Date('2026-10-12T12:00:00Z');
 const pages = {
  [base]:'<html></html>',
  [base+'/feed']:`<rss><channel><item><title>Latest published article</title><link>${base}/latest-story</link><pubDate>2026-10-05T12:00:00</pubDate></item></channel></rss>`,
 };
 const utc = await detectSite({...input,source_timezone:'UTC'},fetcher(pages,[]),{observedAt});
 assert.equal(utc.method,'rss');
 assert.ok(!utc.diagnostics.some(message=>message.includes('stale')));
 const dhaka = await detectSite({...input,source_timezone:'Asia/Dhaka'},fetcher(pages,[]),{observedAt});
 assert.ok(dhaka.diagnostics.some(message=>message.includes('stale')));
 const relative = await detectSite(input,fetcher({...pages,[base+'/feed']:pages[base+'/feed'].replace('2026-10-05T12:00:00','2 hours ago')},[]),{observedAt});
 assert.equal(relative.method,'rss');
 assert.ok(!relative.diagnostics.some(message=>message.includes('stale')));
});
test('external feed and sitemap providers retain watched publisher links while excluding foreign publishers',async()=>{
 const provider = 'https://feeds.example.net', observedAt = new Date('2026-10-12T12:00:00Z');
 for (const kind of ['rss','sitemap'] as const) {
  const endpoint = provider+'/'+kind;
  const urls = [base+'/publisher-story','https://foreign.example.com/foreign-story',provider+'/provider-story'];
  const body = kind === 'rss'
   ? `<rss><channel>${urls.map(url=>`<item><title>Publisher article</title><link>${url}</link><pubDate>2026-10-12T11:00:00Z</pubDate></item>`).join('')}</channel></rss>`
   : `<urlset>${urls.map(url=>`<url><loc>${url}</loc><lastmod>2026-10-12T11:00:00Z</lastmod></url>`).join('')}</urlset>`;
  const result = await detectSite({...input,endpoints:[{kind,url:endpoint}]},fetcher({
   [base]:'<html></html>',[base+'/robots.txt']:'',[endpoint]:body,
  },[]),{observedAt});
  assert.equal(result.method,kind);
  assert.equal(result.endpoints[0].url,endpoint);
  assert.deepEqual(result.preview.map(post=>post.url),[base+'/publisher-story']);
  const directPreview = kind === 'rss' ? feedPreview(body,endpoint,base) : sitemapPreview(body,endpoint,'Asia/Dhaka',observedAt,base).posts;
  assert.deepEqual(directPreview.map(post=>post.url),[base+'/publisher-story']);
 }
});
