import { resolvePublication } from './article-dates';

// lastmod is used here only to order discovery work, never as publication evidence.
export function sitemapDate(raw: string | null | undefined, timeZone = 'Asia/Dhaka'): bigint | null {
 if (!raw) return null;
 const parsed = resolvePublication([{raw,source:'news-sitemap'}],{observedAt:new Date(0),timeZone});
 return parsed.confidence === 'verified' && !parsed.precision?.startsWith('relative-')
  && parsed.publishedAtMicros !== null ? BigInt(parsed.publishedAtMicros) : null;
}
export function isNewsSitemapUrl(url: string): boolean {
 return /(?:^|[\/_.-])news(?:[\/_.-]|$)/i.test(new URL(url).pathname);
}
function orderingDate(published: string | null | undefined, modified: string | null | undefined, timeZone: string) {
 const publication = sitemapDate(published,timeZone);
 return publication !== null ? publication : sitemapDate(modified,timeZone);
}
export function newestSitemapEntries<T extends {published?: string | null; modified?: string | null}>(items:T[], timeZone='Asia/Dhaka'):T[] {
 return items.map((item,index)=>({item,index,date:orderingDate(item.published,item.modified,timeZone)}))
  .sort((a,b)=> a.date === b.date ? a.index-b.index : a.date === null ? 1 : b.date === null ? -1 : a.date > b.date ? -1 : 1)
  .map(entry=>entry.item);
}
export function newestSitemapChildren<T extends {url:string;modified?:string|null}>(items:T[],timeZone='Asia/Dhaka'):T[] {
 return newestSitemapEntries(items,timeZone).sort((a,b)=>Number(isNewsSitemapUrl(b.url))-Number(isNewsSitemapUrl(a.url)));
}
