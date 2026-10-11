import { load } from 'cheerio';
import { normalizeSiteUrl } from './sites';
import { safeFetchPage, type PageFetcher, type RawPage } from './safe-http';
import { newestSitemapEntries, newestSitemapChildren } from './sitemap-selection';
import { assessSourceFreshness, type SourceFreshness } from './source-freshness';
import { isArticleCandidateUrl } from './article-candidates';
export type Method = 'rss' | 'sitemap' | 'listing';
export type Endpoint = { kind: Method; url: string; configured?: boolean };
export type PreviewPost = { title: string; url: string; raw_date: string | null; date_kind: 'publication' | 'modified' | null };
export type DetectionResult = { method: Method | 'extension' | 'pending'; status: 'ready' | 'needs_attention'; endpoints: Endpoint[]; preview: PreviewPost[]; diagnostics: string[] };
export type DetectionInput = { url: string; listing_url: string | null; scan_depth: number; endpoints: Endpoint[]; source_timezone?: string };
const MAX_PREVIEW = 8;
export const DETECTION_TIMEOUT_MS = 20_000;
export const MAX_DETECTION_REQUESTS = 12;
export function xmlDocument(body: string) {
 if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(body)) throw new Error('XML declarations/entities are not allowed.');
 return load(body, {xml:true});
}
function link(raw: string | undefined, base: string) {
 if (!raw) return null;
 try { return normalizeSiteUrl(raw,base); } catch { return null; }
}
function distinct(posts: PreviewPost[]) {
 const unique = [...new Map(posts.map(post => [post.url,post])).values()];
 return unique.sort((a,b) => {
  const first = a.raw_date ? Date.parse(a.raw_date) : NaN;
  const second = b.raw_date ? Date.parse(b.raw_date) : NaN;
  return Number.isFinite(first) && Number.isFinite(second) ? second-first : 0;
 }).slice(0,MAX_PREVIEW);
}
function feedPosts(body: string, base: string, site = base) {
 const $ = xmlDocument(body);
 const isFeed = !!$('rss, feed, rdf\\:RDF').length;
 const posts: PreviewPost[] = [], dates: {published:string|null}[] = [];
 if (!isFeed) return {posts,dates,isFeed};
 $('item, entry').each((_index,element) => {
  const entry = $(element);
  const raw_date = entry.find('pubDate, published, dc\\:date').first().text().trim() || null;
  dates.push({published:raw_date});
  const atomLink = entry.find('link').filter((_i,node) => !$(node).attr('rel') || $(node).attr('rel') === 'alternate').first();
  const url = link(atomLink.attr('href') || atomLink.text().trim(),base);
  if (!url || !isArticleCandidateUrl(url,site)) return;
  posts.push({title:entry.find('title').first().text().trim().slice(0,500) || url,url,raw_date,date_kind:raw_date ? 'publication' : null});
 });
 return {posts,dates,isFeed};
}
export function feedPreview(body: string, base: string, site = base): PreviewPost[] {
 return distinct(feedPosts(body,base,site).posts);
}
export function sitemapPreview(body: string, base: string, timeZone = 'Asia/Dhaka', observedAt = new Date(), site = base): { posts: PreviewPost[]; children: string[]; diagnostics: string[]; freshness: SourceFreshness | null } {
 const $ = xmlDocument(body);
 const entries: (PreviewPost & {published:string|null;modified:string|null})[] = [], childEntries: {url:string;modified:string|null}[] = [], diagnostics: string[] = [];
 const freshnessEntries: {published:string|null;modified:string|null}[] = [];
 if ($('sitemapindex').length) $('sitemap').each((_i,element) => {
  const entry = $(element), url = link(entry.children('loc').text().trim(),base);
  if (url) childEntries.push({url,modified:entry.children('lastmod').text().trim() || null});
 });
 if ($('urlset').length) $('url').each((_i,element) => {
  const entry = $(element);
  const published = entry.find('news\\:publication_date').text().trim() || null;
  const modified = entry.children('lastmod').text().trim() || null;
  freshnessEntries.push({published,modified});
  const url = link(entry.children('loc').text().trim(),base);
  if (!url || !isArticleCandidateUrl(url,site)) return;
  entries.push({url,title:entry.find('news\\:title').text().trim().slice(0,500) || url,raw_date:published || modified || null,date_kind:published ? 'publication' : modified ? 'modified' : null,published,modified});
 });
 // Read the full bounded document before limiting results. Oldest-first sitemaps
 // must not conceal recent posts merely because they occur after entry 200.
 const seenPosts = new Set<string>(), seenChildren = new Set<string>();
 const orderedPosts = newestSitemapEntries(entries,timeZone).filter(entry => {
  if (seenPosts.has(entry.url)) return false; seenPosts.add(entry.url); return true;
 });
 const orderedChildren = newestSitemapChildren(childEntries,timeZone).filter(entry => {
  if (seenChildren.has(entry.url)) return false; seenChildren.add(entry.url); return true;
 });
 if (orderedPosts.length > MAX_PREVIEW) diagnostics.push(`Coverage limited: sitemap preview shows the newest ${MAX_PREVIEW} of ${orderedPosts.length} safe URLs.`);
 if (orderedChildren.length > 20) diagnostics.push(`Coverage limited: sitemap index preview selects the first 20 prioritized child maps of ${orderedChildren.length}.`);
 const posts = orderedPosts.slice(0,200).slice(0,MAX_PREVIEW).map(({published:_published,modified:_modified,...post})=>post);
 return {posts,children:orderedChildren.slice(0,20).map(entry=>entry.url),diagnostics,
  freshness:$('urlset').length || ($('sitemapindex').length && !childEntries.length) ? assessSourceFreshness(freshnessEntries,{observedAt,timeZone}) : null};
}
function sameSite(url: string, site: string) {
 return new URL(url).hostname.replace(/^www\./,'') === new URL(site).hostname.replace(/^www\./,'');
}
export function listingPreview(body: string, base: string, site = base): PreviewPost[] {
 const $ = load(body);
 $('script, style, nav, header, footer, aside').remove();
 const posts: PreviewPost[] = [];
 $('a[href]').each((_i,element) => {
  const anchor = $(element), url = link(anchor.attr('href'),base), title = anchor.text().replace(/\s+/g,' ').trim();
  if (!url || !isArticleCandidateUrl(url,site,{listing:true})) return;
  const date = anchor.closest('article,li,.news-item,.news-card,.story,.post,.item').find('time').filter((_i,node)=>
   !/modif|updat/i.test([$(node).attr('itemprop'),$(node).attr('class'),$(node).attr('id')].join(' '))).first();
  const raw_date = date.attr('datetime') || date.text().trim() || null;
  posts.push({url,title:title.slice(0,500) || url,raw_date,date_kind:raw_date ? 'publication' : null});
 });
 return distinct(posts);
}
export async function detectSite(input: DetectionInput, fetchPage: PageFetcher = safeFetchPage, options: { timeoutMs?: number; signal?: AbortSignal; observedAt?: Date } = {}): Promise<DetectionResult> {
 const timeout = AbortSignal.timeout(options.timeoutMs ?? DETECTION_TIMEOUT_MS);
 const signal = options.signal ? AbortSignal.any([timeout,options.signal]) : timeout;
 const diagnostics: string[] = [];
 let requests = 0, blocked = false;
 const cache = new Map<string,RawPage | null>();
 async function fetch(raw: string) {
  const url = normalizeSiteUrl(raw,input.url);
  if (cache.has(url)) return cache.get(url)!;
  if (requests >= MAX_DETECTION_REQUESTS) { diagnostics.push('Discovery request limit reached.'); return null; }
  signal.throwIfAborted(); requests++;
  try {
   const page = await new Promise<RawPage>((resolve,reject) => {
    const aborted = () => reject(new Error('Site detection timed out or was interrupted.'));
    signal.addEventListener('abort',aborted,{once:true});
    fetchPage(url,signal).then(resolve,reject).finally(() => signal.removeEventListener('abort',aborted));
   });
   if (/captcha|cf-chl-|verify (?:you are|that you are) human|unusual traffic/i.test(page.body.slice(0,100_000))) {
    blocked = true; throw new Error('Browser verification or CAPTCHA detected.');
   }
   cache.set(url,page); return page;
  } catch (error) {
   const message = error instanceof Error ? error.message : 'Fetch failed.';
   if (/HTTP (403|429)/.test(message)) blocked = true;
   diagnostics.push(`${url}: ${message}`); cache.set(url,null); return null;
  }
 }
 const success = (method: Method, url: string, posts: PreviewPost[], sorted = false): DetectionResult => ({method,status:'ready',endpoints:[{kind:method,url}],preview:sorted ? posts.slice(0,MAX_PREVIEW) : distinct(posts),diagnostics});
 const observedAt = options.observedAt ?? new Date();
 const timeZone = input.source_timezone ?? 'Asia/Dhaka';
 let staleSource: {method: 'rss' | 'sitemap'; url: string; posts: PreviewPost[]} | null = null;
 const suppliedListings = [...new Set([...(input.listing_url ? [input.listing_url] : []),...input.endpoints.filter(e => e.kind==='listing').map(e => e.url)])].slice(0,3);
 const visitedListings = new Set<string>();
 async function tryListings(urls: string[]): Promise<DetectionResult | null> {
  const listings = urls.map(url => ({url,depth:0}));
  for (let index = 0; index < listings.length && visitedListings.size < 3; index++) {
   const {url,depth} = listings[index]; if (visitedListings.has(url)) continue; visitedListings.add(url);
   const page = await fetch(url); if (!page) continue;
   const posts = listingPreview(page.body,page.url,input.url);
   if (posts.length) return success('listing',page.url,posts);
   if (depth < input.scan_depth) {
    const html = load(page.body);
    html('a[href]').slice(0,100).each((_i,element) => {
     const child = link(html(element).attr('href'),page.url);
     if (child && sameSite(child,input.url) && /\/(?:news|section|category|latest)(?:\/|$)/i.test(new URL(child).pathname)) listings.push({url:child,depth:depth+1});
    });
   }
   diagnostics.push(`${url}: no recognizable article links.`);
  }
  return null;
 }
 try {
  const homepage = await fetch(input.url);
  const $ = load(homepage?.body ?? '');
  const advertisedFeeds: string[] = [];
  $('link[rel="alternate"]').each((_i,element) => {
   if (/rss|atom/i.test($(element).attr('type') ?? '')) {
    const url = link($(element).attr('href'),homepage?.url ?? input.url); if (url) advertisedFeeds.push(url);
   }
  });
  const origin = new URL(homepage?.url ?? input.url).origin;
  const feeds = [...new Set([...input.endpoints.filter(e => e.kind==='rss').map(e => e.url),...advertisedFeeds,`${origin}/feed`,`${origin}/rss.xml`])].slice(0,4);
  for (const url of feeds) {
   const page = await fetch(url); if (!page) continue;
   try {
    const parsed = feedPosts(page.body,page.url,input.url), posts = distinct(parsed.posts);
    const freshness = assessSourceFreshness(parsed.dates,{observedAt,timeZone});
    if (freshness.state === 'fresh' && posts.length) return success('rss',page.url,posts);
    // Only actual source documents get a freshness diagnostic, not a fallback HTML/404 page.
    if (parsed.isFeed) {
     diagnostics.push(`${page.url}: ${freshness.diagnostic}`);
     if (posts.length) staleSource ??= {method:'rss',url:page.url,posts};
     const listing = await tryListings(suppliedListings); if (listing) return listing;
    }
    if (!posts.length) diagnostics.push(`${url}: no feed posts found.`);
   }
   catch (error) { diagnostics.push(`${url}: ${(error as Error).message}`); }
  }
  const robotSitemaps: string[] = [];
  const robots = await fetch(`${origin}/robots.txt`);
  for (const match of robots?.body.matchAll(/^Sitemap:\s*(\S+)/gim) ?? []) {
   const url = link(match[1],origin); if (url) robotSitemaps.push(url);
  }
  const advertisedSitemaps: string[] = [];
  $('link[rel]').each((_i,element) => {
   if (/(?:^|\s)sitemap(?:\s|$)/i.test($(element).attr('rel') ?? '')) {
    const url = link($(element).attr('href'),homepage?.url ?? input.url); if (url) advertisedSitemaps.push(url);
   }
  });
  const declaredMaps = [...new Set([...input.endpoints.filter(e => e.kind==='sitemap').map(e => e.url),...advertisedSitemaps,...robotSitemaps,`${origin}/sitemap.xml`])];
  const orderedMaps = newestSitemapChildren(declaredMaps.map(url=>({url})));
  if (orderedMaps.length > 3) diagnostics.push(`Coverage limited: detection selects 3 prioritized sitemap endpoints of ${orderedMaps.length}.`);
  const maps = orderedMaps.slice(0,3).map(({url})=>({url,depth:0}));
  const seen = new Set<string>();
  for (let index = 0; index < maps.length && seen.size < 4; index++) {
   const {url,depth} = maps[index]; if (seen.has(url)) continue; seen.add(url);
   const page = await fetch(url); if (!page) continue;
   try {
    const parsed = sitemapPreview(page.body,page.url,timeZone,observedAt,input.url);
    diagnostics.push(...parsed.diagnostics.map(message=>`${page.url}: ${message}`));
    if (parsed.freshness?.state === 'stale') {
     diagnostics.push(`${page.url}: ${parsed.freshness.diagnostic}`);
     if (parsed.posts.length) staleSource ??= {method:'sitemap',url:page.url,posts:parsed.posts};
     const listing = await tryListings(suppliedListings); if (listing) return listing;
    } else if (parsed.posts.length) return success('sitemap',page.url,parsed.posts,true);
    if (depth < 2) {
     if (parsed.children.length > 3) diagnostics.push(`${page.url}: Coverage limited: detection selects 3 prioritized child maps of ${parsed.children.length}.`);
     maps.splice(index+1,0,...parsed.children.slice(0,3).filter(url=>!seen.has(url)).map(url => ({url,depth:depth+1})));
    } else if (parsed.children.length) diagnostics.push(`${page.url}: Coverage limited: sitemap depth limit reached; child maps were not fetched.`);
    diagnostics.push(`${url}: no sitemap posts found${parsed.children.length ? ' (index)' : ''}.`);
   } catch (error) { diagnostics.push(`${url}: ${(error as Error).message}`); }
  }
  if (seen.size >= 4 && maps.some(({url})=>!seen.has(url))) diagnostics.push('Coverage limited: detection sitemap request limit reached; remaining maps were not fetched.');
  const listing = await tryListings([...new Set([...suppliedListings,input.url])].slice(0,3));
  if (listing) return listing;
  if (staleSource) return success(staleSource.method,staleSource.url,staleSource.posts,true);
 } catch (error) { diagnostics.push(signal.aborted ? 'Site detection timed out or was interrupted.' : (error as Error).message); }
 return {method:blocked ? 'extension' : 'pending',status:'needs_attention',endpoints:[],preview:[],diagnostics:diagnostics.length ? diagnostics : ['No posts found; configure an endpoint and retry.']};
}
