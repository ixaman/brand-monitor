import { resolvePublication } from './article-dates';

export type SourceFreshness = { state: 'fresh' | 'stale'; diagnostic: string };
export const SOURCE_FRESHNESS_DAYS = 7;

/** Source health only. A generic sitemap's lastmod never establishes article publication. */
export function assessSourceFreshness(entries: { published?: string | null; modified?: string | null }[],
 options: { observedAt?: Date; timeZone?: string } = {}): SourceFreshness {
 const observedAt = options.observedAt ?? new Date(), timeZone = options.timeZone ?? 'Asia/Dhaka';
 const now = BigInt(observedAt.getTime()) * 1000n;
 const cutoff = now - BigInt(SOURCE_FRESHNESS_DAYS) * 24n * 60n * 60n * 1_000_000n;
 let latest: bigint | null = null;
 const sourceDate = (raw: string | null | undefined): bigint | null => {
  if (!raw) return null;
  const parsed = resolvePublication([{raw,source:'news-sitemap',observedAt}],{observedAt,timeZone});
  return parsed.confidence === 'verified' && parsed.publishedAtMicros !== null ? BigInt(parsed.publishedAtMicros) : null;
 };
 for (const entry of entries) {
  const date = sourceDate(entry.published) ?? sourceDate(entry.modified);
  if (date === null || date > now) continue;
  if (date >= cutoff) return {state:'fresh',diagnostic:'Source is fresh: an entry is dated within the last 7 days.'};
  if (latest === null || date > latest) latest = date;
 }
 const detail = latest === null ? 'no valid nonfuture entry dates found' : `latest entry date ${new Date(Number(latest / 1000n)).toISOString()}`;
 return {state:'stale',diagnostic:`Source is stale: no entry is dated within the last 7 days (${detail}).`};
}
