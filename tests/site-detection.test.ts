import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectSite, feedPreview, sitemapPreview, listingPreview, xmlDocument, MAX_DETECTION_REQUESTS } from '../packages/domain/src/site-detection';
import type { PageFetcher } from '../packages/domain/src/safe-http';
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
