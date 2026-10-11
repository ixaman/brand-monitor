import { articlePublisherHost, canonicalizeArticleUrl } from './article-urls';
import { resolvePublication } from './article-dates';
import type { ArticleDiscovery } from './article-collection';
import { normalizeSiteUrl } from './sites';

export const MAX_SITE_CANDIDATES_PER_SCAN = 100;
const nonArticleSegments = /^(?:categor(?:y|ies)|tags?|archives?|authors?|search|print|printer|printable|pagination|pages?|sections?|topics?|feeds?|rss|sitemap(?:s)?|contact|about|privacy|terms|login|register)(?:\.(?:html?|php|aspx?))?$/iu;
const sectionNames = /^(?:(?:home|index|default)(?:\.(?:html?|php|aspx?))?|news|latest|latest-news|all-news|bangladesh|national|international|world|politics|sports|business|economy|entertainment|opinion|editorial|education|technology|lifestyle|photo|photos|video|videos|amp)$/iu;

/** Shared queue guard; listing links additionally need an article-shaped path. */
export function isArticleCandidateUrl(raw: string, base: string, options: { listing?: boolean } = {}): boolean {
 try {
  const url = new URL(normalizeSiteUrl(raw, base, true)), site = new URL(normalizeSiteUrl(base));
  const host = options.listing ? (value: string) => value.toLowerCase().replace(/^www\./u, '') : articlePublisherHost;
  if (host(url.hostname) !== host(site.hostname)) return false;
  const canonical = new URL(canonicalizeArticleUrl(url.toString()));
  if (canonical.toString() === new URL(canonicalizeArticleUrl(site.toString())).toString()) return false;
  const rawSegments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const segments = decodeURIComponent(canonical.pathname).split('/').filter(Boolean);
  for (const [key, value] of url.searchParams) {
   if (/^(?:s|q|query|search|searchword|category|cat|tag|archive|author|page|paged|pagenum|pageno|offset|print|printable|printer)$/iu.test(key)) return false;
   if (/^(?:output|display|view|format)$/iu.test(key) && /^(?:print|printer|printable|1)$/iu.test(value)) return false;
  }
  const contentId = [...url.searchParams].some(([key, value]) => /^(?:p|id|article|article_id|story|story_id|news_id)$/iu.test(key) && /^\d+$/u.test(value));
  if (!segments.length) return contentId;
  if (rawSegments.some(segment => nonArticleSegments.test(segment))) return false;
  if (/\.(?:xml|json|rss|atom|txt|pdf|jpe?g|png|gif|webp|svg|css|js|ico|woff2?)$/iu.test(segments.at(-1)!)) return false;
  if (/^\d{4}$/u.test(segments[0]) && segments.length <= 3 && segments.slice(1).every(segment => /^\d{1,2}$/u.test(segment))) return false;
  if (sectionNames.test(segments.at(-1)!) && !contentId) return false;
  if (options.listing && segments.length === 1 && !contentId && !/[-_\d]/u.test(segments[0])) return false;
  return true;
 } catch { return false; }
}

/** Publication evidence never includes generic sitemap lastmod. */
export function articleDiscoveryPublicationMicros(discovery: ArticleDiscovery, timeZone: string): bigint | null {
 const publication = resolvePublication(discovery.dateEvidence, { observedAt: discovery.discoveredAt, timeZone });
 return publication.publishedAtMicros === null ? null : BigInt(publication.publishedAtMicros);
}

export function sortArticleDiscoveries<T extends ArticleDiscovery>(discoveries: T[], timeZone = 'Asia/Dhaka'): T[] {
 return discoveries.map((discovery, index) => ({ discovery, index, published: articleDiscoveryPublicationMicros(discovery, timeZone) }))
  .sort((a, b) => a.published !== b.published
   ? a.published === null ? 1 : b.published === null ? -1 : a.published > b.published ? -1 : 1
   : b.discovery.discoveredAt.getTime() - a.discovery.discoveredAt.getTime() || a.index - b.index)
  .map(item => item.discovery);
}
