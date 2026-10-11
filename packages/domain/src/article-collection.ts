import { xmlDocument } from './site-detection';
import type { Endpoint, Method } from './site-detection';
import type { PageFetcher } from './safe-http';
import { normalizeSiteUrl } from './sites';
import type { DateEvidence } from './article-dates';
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
export function parseArticleSitemap(body: string, base: string, observedAt: Date) {
 const $=xmlDocument(body), discoveries: ArticleDiscovery[]=[], children:string[]=[];
 if (!$('urlset,sitemapindex').length) throw new Error('Not an XML sitemap.');
 if ($('url').length>MAX_COLLECTION_ARTICLES) throw new Error('Sitemap exceeds 1000 articles; coverage is incomplete.');
 $('sitemap > loc').each((_i,node)=> {try {children.push(normalizeSiteUrl($(node).text().trim(),base));}catch{}});
 $('url').slice(0,MAX_COLLECTION_ARTICLES).each((_i,node)=> {
  const entry=$(node); let url:string;try{url=normalizeSiteUrl(entry.children('loc').text().trim(),base,true);}catch{return;}
  const published=entry.find('news\\:publication_date').first().text().trim();
  discoveries.push({url,source:'sitemap',discoveredAt:observedAt,dateEvidence:published?[{raw:published,source:'news-sitemap',observedAt}]:[]});
 });
 return {discoveries,children};
}
export async function collectArticleLinks(site: {method:string;endpoints:Endpoint[]}, fetchPage: PageFetcher, signal = new AbortController().signal) {
 if (!['rss','sitemap'].includes(site.method)) throw new Error('Continuous listing/site-search collection is deferred to slice 5.');
 const endpoints=site.endpoints.filter(e=> e.kind===site.method);
 if (!endpoints.length) throw new Error('No discovery endpoint configured.');
 const discoveries:ArticleDiscovery[]=[], visited=new Set<string>();
 const pending=endpoints.map(e=>({url:e.url,depth:0}));
 while (pending.length) {
  signal.throwIfAborted();
  const next=pending.shift()!;
  if (visited.has(next.url)) continue;
  if (visited.size>=20) throw new Error('Collection capped at 20 endpoints; remaining coverage is unverified.');
  visited.add(next.url);
  const page=await fetchPage(next.url,signal), observedAt=new Date();
  if(site.method==='rss') discoveries.push(...parseArticleFeed(page.body,page.url,observedAt));
  else {
   const parsed=parseArticleSitemap(page.body,page.url,observedAt); discoveries.push(...parsed.discoveries);
   if(parsed.children.length && next.depth>=2) throw new Error('Sitemap index depth capped at 2.');
   pending.push(...parsed.children.map(url=>({url,depth:next.depth+1})));
  }
  if (discoveries.length>MAX_COLLECTION_ARTICLES) throw new Error('Collection capped at 1000 articles.');
 }
 const merged=new Map<string,ArticleDiscovery>();
 for(const discovery of discoveries) {
  const prior=merged.get(discovery.url);
  if(prior) {
   prior.dateEvidence.push(...discovery.dateEvidence);
   if(discovery.discoveredAt<prior.discoveredAt)prior.discoveredAt=discovery.discoveredAt;
  }else merged.set(discovery.url,discovery);
 }
 return [...merged.values()];
}
