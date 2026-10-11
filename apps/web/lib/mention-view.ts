// Presentation helpers only; publication eligibility is enforced by PostgreSQL.
export type Tab = 'new' | 'all' | 'flagged' | 'unverified';
export type Status = 'new' | 'reviewed' | 'flagged' | 'ignored';
export type Match = { keyword_id: string; keyword: string; matched_term: string; excerpt: string; matched_in: 'title' | 'body'; highlight_start: number; highlight_end: number };
export type Mention = { id: string; article_id: string; title: string; url: string; site: string; published_at: string | null; discovered_at: string; date_reason: string | null; unverified: boolean; in_main_feed: boolean; expires_at: number | null; status: Status; sources: string[]; matches: Match[] };
export function visibleMentions(rows: Mention[], now: number) { return rows.filter(row => row.unverified || row.expires_at === null || row.expires_at >= now); }
export function inTab(row: Mention, tab: Tab, now?: number) {
 if (tab === 'unverified') return row.unverified;
 return row.in_main_feed && (now === undefined || row.expires_at === null || row.expires_at >= now) && (tab === 'all' || row.status === tab);
}
export function tabCounts(rows: Mention[], now?: number) { return Object.fromEntries((['new','all','flagged','unverified'] as const).map(tab => [tab,rows.filter(row => inTab(row,tab,now)).length])) as Record<Tab,number>; }
export function highlightParts(match: Match) { return [match.excerpt.slice(0,match.highlight_start),match.excerpt.slice(match.highlight_start,match.highlight_end),match.excerpt.slice(match.highlight_end)]; }
export function dhakaTime(value: string) { return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'medium',timeStyle:'medium'}).format(new Date(value)); }
