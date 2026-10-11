import { normalizeSiteUrl } from './sites';

/** Publisher aliases we can resolve without treating unrelated subdomains as the same site. */
export function articlePublisherHost(host: string): string {
 return host.toLowerCase().replace(/^(?:www|m|mobile|amp)\./, '');
}

function normalizeArticleUrl(raw: string, base?: string): string {
 const url = new URL(normalizeSiteUrl(raw, base));
 url.hostname = articlePublisherHost(url.hostname);
 // Only rewrite conventional representation markers; retain content IDs and path case.
 if (!/^\/amp\/?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/amp\/?$/i, '').replace(/^\/amp\/(?=.+)/i, '/');
 for (const [key, value] of [...url.searchParams.entries()]) {
  if (/^amp$/i.test(key) && /^(?:|1|true)$/i.test(value)) url.searchParams.delete(key);
  if (/^(?:output|display)$/i.test(key) && /^amp$/i.test(value)) url.searchParams.delete(key);
  if (/^mobile$/i.test(key) && /^(?:1|true)$/i.test(value)) url.searchParams.delete(key);
 }
 return normalizeSiteUrl(url.toString());
}

/**
 * An article identity is a public HTTP(S) URL. A canonical claim can move only
 * within the publisher's recognized host aliases. Homepage canonicals on article
 * pages are ignored: some publishers incorrectly put their site URL on every page.
 */
export function canonicalizeArticleUrl(raw: string, base?: string, canonicalHref?: string | null): string {
 const original = normalizeArticleUrl(raw, base);
 if (!canonicalHref) return original;
 try {
  const claimed = normalizeArticleUrl(canonicalHref, raw.startsWith('http') ? raw : original);
  const source = new URL(original), canonical = new URL(claimed);
  if (articlePublisherHost(source.hostname) !== articlePublisherHost(canonical.hostname)) return original;
  if (source.pathname !== '/' && canonical.pathname === '/' && !canonical.search) return original;
  return claimed;
 } catch { return original; }
}
