import { xmlDocument } from './site-detection';
import { load } from 'cheerio';
import type { Endpoint, Method } from './site-detection';
import type { PageFetcher } from './safe-http';
import { normalizeSiteUrl } from './sites';
import type { DateEvidence } from './article-dates';
import { isNewsSitemapUrl, newestSitemapChildren, newestSitemapEntries } from './sitemap-selection';
import { canonicalizeArticleUrl } from './article-urls';
import { isArticleCandidateUrl, sortArticleDiscoveries, MAX_SITE_CANDIDATES_PER_SCAN } from './article-candidates';
import { assessSourceFreshness } from './source-freshness';
export type ArticleDiscovery = { url: string; source: Method; discoveredAt: Date; dateEvidence: DateEvidence[] };
export const MAX_COLLECTION_ARTICLES = 1000;
export function parseArticleFeed(body: string, base: string, observedAt: Date): ArticleDiscovery[] {
 const $ = xmlDocument(body);
 if (!$('rss,feed,rdf\\:RDF').length) throw new Error('Not an RSS/Atom feed.');
 if ($('item,entry').length>MAX_COLLECTION_ARTICLES) throw new Error('Feed exceeds 1000 articles; coverage is incomplete.');
 const discoveries: ArticleDiscovery[]=[];
 $('item,entry').slice(0,MAX_COLLECTION_ARTICLES).each((_i,element) => {
  const entry=$(element);
  const anchor=entry.find('link').filter((_j,node)=> !$(node).attr('rel') || $(node).attr('rel')==='alternate').first();
  const raw=anchor.attr('href') || anchor.text().trim();
  if (!raw) return;
  let url: string; try { url=normalizeSiteUrl(raw,base,true); } catch { return; }
  const published=entry.find('pubDate,published,dc\\:date').first().text().trim();
  discoveries.push({url,source:'rss',discoveredAt:observedAt,dateEvidence:published?[{raw:published,source:'feed',observedAt}]:[]});
 });
 return discoveries;
}
export function parseArticleSitemap(body: string, base: string, observedAt: Date, timeZone='Asia/Dhaka') {
 const $=xmlDocument(body), entries:(ArticleDiscovery & {published:string|null;modified:string|null})[]=[], childEntries:{url:string;modified:string|null}[]=[];
 if (!$('urlset,sitemapindex').length) throw new Error('Not an XML sitemap.');
 $('sitemap').each((_i,node)=> {
  const entry=$(node);try{childEntries.push({url:normalizeSiteUrl(entry.children('loc').text().trim(),base),modified:entry.children('lastmod').text().trim() || null});}catch{}
 });
 $('url').each((_i,node)=> {
  const entry=$(node); let url:string;try{url=normalizeSiteUrl(entry.children('loc').text().trim(),base,true);}catch{return;}
  const published=entry.find('news\\:publication_date').first().text().trim();
  entries.push({url,source:'sitemap',discoveredAt:observedAt,dateEvidence:published?[{raw:published,source:'news-sitemap',observedAt}]:[],
   published:published || null,modified:entry.children('lastmod').text().trim() || null});
 });
 const sortedChildren=newestSitemapChildren(childEntries,timeZone);
 const diagnostics=entries.length>MAX_COLLECTION_ARTICLES
  ? [`Coverage limited: kept the newest ${MAX_COLLECTION_ARTICLES} of ${entries.length} sitemap entries; lastmod is ordering only.`] : [];
 return {discoveries:newestSitemapEntries(entries,timeZone).slice(0,MAX_COLLECTION_ARTICLES),children:sortedChildren.map(child=>child.url),
  childEntries:sortedChildren,diagnostics,isNews:entries.some(entry=>entry.published) || isNewsSitemapUrl(base)};
}
export type CollectionSite = {method:string;endpoints:Endpoint[];url?:string;listing_url?:string|null;scan_depth?:number;source_timezone?:string};
export type CollectionOptions = {diagnostics?:string[];knownUrls?:Iterable<string>;observedAt?:Date};

/** Listing dates are raw observations; only explicit publication times become evidence. */
export function parseArticleListing(body:string,base:string,site:string,observedAt:Date):ArticleDiscovery[] {
 const $=load(body),discoveries:ArticleDiscovery[]=[];
 $('script,style,nav,header,footer,aside').remove();
 $('a[href]').each((_index,node)=>{
  const anchor=$(node);let url:string;
  try {url=normalizeSiteUrl(anchor.attr('href')!,base,true);}catch{return;}
  if(!isArticleCandidateUrl(url,site,{listing:true}))return;
  const container=anchor.closest('article,li,.news-item,.news-card,.story,.post,.item');
  const time=container.find('time').filter((_i,element)=> !/modif|updat/i.test([
   $(element).attr('itemprop'),$(element).attr('class'),$(element).attr('id')
  ].join(' '))).first();
  const raw=time.attr('datetime') || time.text().trim();
  discoveries.push({url,source:'listing',discoveredAt:observedAt,dateEvidence:raw?[{raw,source:'time',observedAt}]:[]});
 });
 return discoveries;
}

export async function collectArticleLinks(site:CollectionSite,fetchPage:PageFetcher,signal=new AbortController().signal,options:CollectionOptions={}) {
 const diagnostics=options.diagnostics ?? [],timeZone=site.source_timezone ?? 'Asia/Dhaka';
 const note=(message:string)=>{if(!diagnostics.includes(message))diagnostics.push(message);};
 const listingRoots=[...new Set([...(site.listing_url?[site.listing_url]:[]),...site.endpoints.filter(e=>e.kind==='listing').map(e=>e.url)])];
 if(site.method==='listing' && !listingRoots.length && site.url)listingRoots.push(site.url);
 const endpoints=site.endpoints.filter(e=>e.kind===site.method && e.kind!=='listing');
 if(!endpoints.length && !listingRoots.length)throw new Error('No discovery endpoint configured.');
 const siteUrl=site.url ?? listingRoots[0] ?? endpoints[0].url;
 const known=new Set([...options.knownUrls ?? []].map(url=>canonicalizeArticleUrl(url)));
 const fresh:ArticleDiscovery[]=[],stale:ArticleDiscovery[]=[];
 let sourceSucceeded=false,sourceError:unknown;
 const clock=()=>options.observedAt ?? new Date();
 try {
  if(site.method==='sitemap' && endpoints.length) {
   const sources:SourceEntries[]=[];
   const links=await collectSitemapLinks(endpoints,fetchPage,signal,timeZone,diagnostics,sources,clock);
   const health=assessSourceFreshness(sources.flatMap(source=>source.entries),{observedAt:clock(),timeZone});
   for(const source of sources) {
    if(assessSourceFreshness(source.entries,{observedAt:clock(),timeZone}).state==='stale')note(`${source.url}: ${assessSourceFreshness(source.entries,{observedAt:clock(),timeZone}).diagnostic}`);
   }
   (health.state==='stale'?stale:fresh).push(...links);sourceSucceeded=true;
  } else if(site.method==='rss' && endpoints.length) {
   const visited=new Set<string>();let count=0;
   for(const endpoint of endpoints) {
    signal.throwIfAborted();if(visited.has(endpoint.url))continue;
    if(visited.size>=20)throw new Error('Collection capped at 20 endpoints; remaining coverage is unverified.');
    visited.add(endpoint.url);
    const page=await fetchPage(endpoint.url,signal),links=parseArticleFeed(page.body,page.url,clock());
    count+=links.length;if(count>MAX_COLLECTION_ARTICLES)throw new Error('Collection capped at 1000 articles.');
    const health=assessSourceFreshness(links.map(link=>({published:link.dateEvidence[0]?.raw})),{observedAt:clock(),timeZone});
    if(health.state==='stale')note(`${page.url}: ${health.diagnostic}`);
    (health.state==='stale'?stale:fresh).push(...links);sourceSucceeded=true;
   }
  }
 }catch(error) {
  signal.throwIfAborted();sourceError=error;
  if(!listingRoots.length)throw error;
  note(`Source collection failed; trying supplied listing pages: ${error instanceof Error?error.message:String(error)}`);
 }
 const listing:ArticleDiscovery[]=[],visited=new Set<string>();
 const pending=listingRoots.map(url=>({url,depth:0}));let listingSucceeded=false,listingError:unknown;
 const depthLimit=Math.min(2,Math.max(0,site.scan_depth ?? 0));
 while(pending.length) {
  signal.throwIfAborted();const next=pending.shift()!;
  let url:string;try {url=normalizeSiteUrl(next.url,siteUrl,true);}catch{continue;}
  if(!sameListingHost(url,siteUrl) || visited.has(url))continue;
  if(visited.size>=20){note('Coverage limited: read only 20 listing pages.');break;}
  visited.add(url);
  try {
   const page=await fetchPage(url,signal);
   if(!sameListingHost(page.url,siteUrl))throw new Error('Listing redirected outside the site host.');
   listingSucceeded=true;
   listing.push(...parseArticleListing(page.body,page.url,siteUrl,clock()).filter(link=>!known.has(canonicalizeArticleUrl(link.url))));
   if(next.depth<depthLimit) {
    const $=load(page.body);
    $('a[href]').each((_index,node)=>{
     let child:string;try{child=normalizeSiteUrl($(node).attr('href')!,page.url,true);}catch{return;}
     if(sameListingHost(child,siteUrl) && !isArticleCandidateUrl(child,siteUrl,{listing:true}) && isListingPageUrl(child))pending.push({url:child,depth:next.depth+1});
    });
   }
  }catch(error) {
   signal.throwIfAborted();listingError=error;note(`${url}: ${error instanceof Error?error.message:String(error)}`);
  }
 }
 if(!sourceSucceeded && !listingSucceeded)throw sourceError ?? listingError ?? new Error('No usable discovery endpoint configured.');
 if(stale.length && listingSucceeded)note('Preferred supplied listing pages over stale feed/sitemap entries.');
 const merged=new Map<string,ArticleDiscovery>();
 for(const discovery of [...fresh,...(listingSucceeded?[]:stale),...listing]) {
  if(!isArticleCandidateUrl(discovery.url,siteUrl,{listing:discovery.source==='listing'}))continue;
  const identity=canonicalizeArticleUrl(discovery.url);
  if(discovery.source==='listing' && known.has(identity))continue;
  const key=`${identity}\0${discovery.source}`,prior=merged.get(key);
  if(prior){prior.dateEvidence.push(...discovery.dateEvidence);if(discovery.discoveredAt<prior.discoveredAt)prior.discoveredAt=discovery.discoveredAt;}
  else merged.set(key,discovery);
 }
 // Cap URL identities across all sources, preserving provenance for the selected URLs.
 const ordered=sortArticleDiscoveries([...merged.values()],timeZone),selected=new Set<string>();
 const result=ordered.filter(link=>{
  const identity=canonicalizeArticleUrl(link.url);
  if(known.has(identity))return true;
  if(selected.has(identity))return true;
  if(selected.size>=MAX_SITE_CANDIDATES_PER_SCAN)return false;
  selected.add(identity);return true;
 });
 if(result.length<ordered.length)note(`Coverage limited: queued at most ${MAX_SITE_CANDIDATES_PER_SCAN} new article URLs for this site per scan.`);
 return result;
}
function sameListingHost(url:string,site:string) {
 return new URL(url).hostname.replace(/^www\./,'')===new URL(site).hostname.replace(/^www\./,'');
}
function isListingPageUrl(url:string) {
 const target=new URL(url);
 return /\/(?:news|section|category|categories|latest|page)(?:\/|$)/i.test(target.pathname)
  || /^\/(?:world|bangladesh|national|politics|sports|business|opinion|international)\/?$/i.test(target.pathname)
  || [...target.searchParams.keys()].some(key=>/^(?:page|paged|pageno|offset)$/i.test(key));
}
type SourceEntries={url:string;entries:{published?:string|null;modified?:string|null}[]};
async function collectSitemapLinks(endpoints:Endpoint[],fetchPage:PageFetcher,signal:AbortSignal,timeZone:string,diagnostics:string[],sources:SourceEntries[],clock:()=>Date) {
 type Entry=ReturnType<typeof parseArticleSitemap>['discoveries'][number];
 const discoveries:Entry[]=[], newsDiscoveries:Entry[]=[], visited=new Set<string>();
 let pending=newestSitemapChildren(endpoints.map(e=>({url:e.url,depth:0})),timeZone);
 const note=(message:string)=>{if(!diagnostics.includes(message))diagnostics.push(message);};
 while(pending.length) {
  signal.throwIfAborted();
  const next=pending.shift()!;
  if(visited.has(next.url))continue;
  // Once a productive news sitemap is available, it supplies the recent coverage.
  if(newsDiscoveries.length && !isNewsSitemapUrl(next.url)) {
   note('Coverage limited: preferred the news sitemap over general/archive sitemaps.');continue;
  }
  if(visited.size>=20) {note('Coverage limited: read only the 20 highest-priority sitemap endpoints.');break;}
  visited.add(next.url);
  const page=await fetchPage(next.url,signal),parsed=parseArticleSitemap(page.body,page.url,clock(),timeZone);
  parsed.diagnostics.forEach(note);
  discoveries.push(...parsed.discoveries);
  if(!parsed.children.length || parsed.discoveries.length)sources.push({url:page.url,entries:parsed.discoveries});
  if(parsed.isNews)newsDiscoveries.push(...parsed.discoveries);
  if(parsed.children.length && next.depth>=2) throw new Error('Sitemap index depth capped at 2.');
  pending=newestSitemapChildren([...pending,...parsed.childEntries.map(child=>({...child,depth:next.depth+1}))],timeZone);
 }
 const selected=newsDiscoveries.length?newsDiscoveries:discoveries;
 if(newsDiscoveries.length && discoveries.length>newsDiscoveries.length)note('Coverage limited: preferred the news sitemap over general/archive sitemaps.');
 const merged=new Map<string,Entry>();
 for(const entry of newestSitemapEntries(selected,timeZone)) {
  const previous=merged.get(entry.url);
  if(previous) {
   previous.dateEvidence.push(...entry.dateEvidence);
   if(entry.discoveredAt<previous.discoveredAt)previous.discoveredAt=entry.discoveredAt;
  }else merged.set(entry.url,entry);
 }
 if(merged.size>MAX_COLLECTION_ARTICLES)note(`Coverage limited: kept the newest ${MAX_COLLECTION_ARTICLES} of ${merged.size} entries across sitemaps; lastmod is ordering only.`);
 return [...merged.values()].slice(0,MAX_COLLECTION_ARTICLES);
}
