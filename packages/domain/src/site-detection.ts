import { load } from 'cheerio';
import { normalizeSiteUrl } from './sites';
import { safeFetchPage, type PageFetcher, type RawPage } from './safe-http';
export type Method = 'rss' | 'sitemap' | 'listing';
export type Endpoint = { kind: Method; url: string; configured?: boolean };
export type PreviewPost = { title: string; url: string; raw_date: string | null; date_kind: 'publication' | 'modified' | null };
export type DetectionResult = { method: Method | 'extension' | 'pending'; status: 'ready' | 'needs_attention'; endpoints: Endpoint[]; preview: PreviewPost[]; diagnostics: string[] };
export type DetectionInput = { url: string; listing_url: string | null; scan_depth: number; endpoints: Endpoint[] };
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
export function feedPreview(body: string, base: string): PreviewPost[] {
 const $ = xmlDocument(body);
 if (!$('rss, feed, rdf\\:RDF').length) return [];
 const posts: PreviewPost[] = [];
 $('item, entry').slice(0,100).each((_index,element) => {
  const entry = $(element);
  const atomLink = entry.find('link').filter((_i,node) => !$(node).attr('rel') || $(node).attr('rel') === 'alternate').first();
  const url = link(atomLink.attr('href') || atomLink.text().trim(),base);
  if (!url) return;
  const raw_date = entry.find('pubDate, published, dc\\:date').first().text().trim() || null;
  posts.push({title:entry.find('title').first().text().trim().slice(0,500) || url,url,raw_date,date_kind:raw_date ? 'publication' : null});
 });
 return distinct(posts);
}
export function sitemapPreview(body: string, base: string): { posts: PreviewPost[]; children: string[] } {
 const $ = xmlDocument(body);
 const posts: PreviewPost[] = [], children: string[] = [];
 if ($('sitemapindex').length) $('sitemap > loc').slice(0,20).each((_i,element) => {
  const url = link($(element).text().trim(),base); if (url) children.push(url);
 });
 if ($('urlset').length) $('url').slice(0,200).each((_i,element) => {
  const entry = $(element), url = link(entry.children('loc').text().trim(),base);
  if (!url) return;
  const published = entry.find('news\\:publication_date').text().trim();
  const modified = entry.children('lastmod').text().trim();
  posts.push({url,title:entry.find('news\\:title').text().trim().slice(0,500) || url,raw_date:published || modified || null,date_kind:published ? 'publication' : modified ? 'modified' : null});
 });
 return {posts:distinct(posts),children};
}
function sameSite(url: string, site: string) {
 return new URL(url).hostname.replace(/^www\./,'') === new URL(site).hostname.replace(/^www\./,'');
}
export function listingPreview(body: string, base: string, site = base): PreviewPost[] {
 const $ = load(body);
 $('script, style, nav, header, footer, aside').remove();
 const posts: PreviewPost[] = [];
 $('article a[href], main a[href], h2 a[href], h3 a[href]').slice(0,300).each((_i,element) => {
  const anchor = $(element), url = link(anchor.attr('href'),base), title = anchor.text().replace(/\s+/g,' ').trim();
  if (!url || !sameSite(url,site) || title.length < 8 || url === normalizeSiteUrl(site)) return;
  if (/\/(?:tag|tags|category|categories|author|search|contact|about)(?:\/|\?|$)/i.test(new URL(url).pathname)) return;
  const date = anchor.closest('article').find('time').first();
  const raw_date = date.attr('datetime') || date.text().trim() || null;
  posts.push({url,title:title.slice(0,500),raw_date,date_kind:raw_date ? 'publication' : null});
 });
 return distinct(posts);
}
export async function detectSite(input: DetectionInput, fetchPage: PageFetcher = safeFetchPage, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DetectionResult> {
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
 const success = (method: Method, url: string, posts: PreviewPost[]): DetectionResult => ({method,status:'ready',endpoints:[{kind:method,url}],preview:distinct(posts),diagnostics});
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
   try { const posts = feedPreview(page.body,page.url); if (posts.length) return success('rss',page.url,posts); diagnostics.push(`${url}: no feed posts found.`); }
   catch (error) { diagnostics.push(`${url}: ${(error as Error).message}`); }
  }
  const robotSitemaps: string[] = [];
  const robots = await fetch(`${origin}/robots.txt`);
  for (const match of robots?.body.matchAll(/^Sitemap:\s*(\S+)/gim) ?? []) {
   const url = link(match[1],origin); if (url) robotSitemaps.push(url);
  }
  const maps = [...new Set([...input.endpoints.filter(e => e.kind==='sitemap').map(e => e.url),...robotSitemaps,`${origin}/sitemap.xml`])].slice(0,3).map(url => ({url,depth:0}));
  const seen = new Set<string>();
  for (let index = 0; index < maps.length && seen.size < 4; index++) {
   const {url,depth} = maps[index]; if (seen.has(url)) continue; seen.add(url);
   const page = await fetch(url); if (!page) continue;
   try {
    const parsed = sitemapPreview(page.body,page.url);
    if (parsed.posts.length) return success('sitemap',page.url,parsed.posts);
    if (depth < 2) maps.push(...parsed.children.slice(0,3).map(url => ({url,depth:depth+1})));
    diagnostics.push(`${url}: no sitemap posts found${parsed.children.length ? ' (index)' : ''}.`);
   } catch (error) { diagnostics.push(`${url}: ${(error as Error).message}`); }
  }
  const listings = [...new Set([...(input.listing_url ? [input.listing_url] : []),...input.endpoints.filter(e => e.kind==='listing').map(e => e.url),input.url])].slice(0,3).map(url => ({url,depth:0}));
  const visited = new Set<string>();
  for (let index = 0; index < listings.length && visited.size < 3; index++) {
   const {url,depth} = listings[index]; if (visited.has(url)) continue; visited.add(url);
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
 } catch (error) { diagnostics.push(signal.aborted ? 'Site detection timed out or was interrupted.' : (error as Error).message); }
 return {method:blocked ? 'extension' : 'pending',status:'needs_attention',endpoints:[],preview:[],diagnostics:diagnostics.length ? diagnostics : ['No posts found; configure an endpoint and retry.']};
}
