/** Publication dates only: callers must not submit dateModified or sitemap lastmod. */
export type DateSource = 'jsonld' | 'opengraph' | 'time' | 'feed' | 'news-sitemap' | 'visible';
export type DateEvidence = { raw: string; source: DateSource; observedAt?: Date };
export type ParsedDateEvidence = DateEvidence & {
 publishedAt: Date | null;
 lowerBound: Date | null;
 upperBound: Date | null;
 publishedAtMicros: string | null;
 lowerBoundMicros: string | null;
 upperBoundMicros: string | null;
 precision: string | null;
 timeZone: string | null;
 reason: string | null;
};
export type PublicationResolution = {
 publishedAt: Date | null;
 lowerBound: Date | null;
 upperBound: Date | null;
 /** Decimal epoch microseconds preserve PostgreSQL precision beyond JavaScript Date. */
 publishedAtMicros: string | null;
 lowerBoundMicros: string | null;
 upperBoundMicros: string | null;
 confidence: 'verified' | 'unverified';
 precision: string | null;
 reason: string | null;
 evidence: ParsedDateEvidence[];
};

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
type Parsed = { published: bigint; lower: bigint; upper: bigint; precision: string; timeZone: string | null };
const MICROSECOND = 1n;
const SECOND = 1_000_000n;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;
const rank: Record<DateSource, number> = { jsonld: 0, opengraph: 1, time: 2, feed: 3, 'news-sitemap': 3, visible: 4 };
const months: Record<string, number> = {};
for (const [index, names] of [
 'january jan জানুয়ারি জানুয়ারি', 'february feb ফেব্রুয়ারি ফেব্রুয়ারি', 'march mar মার্চ',
 'april apr এপ্রিল', 'may মে', 'june jun জুন', 'july jul জুলাই', 'august aug আগস্ট অগাস্ট',
 'september sep sept সেপ্টেম্বর', 'october oct অক্টোবর', 'november nov নভেম্বর', 'december dec ডিসেম্বর',
].entries()) for (const name of names.split(' ')) months[name.normalize('NFC')] = index + 1;

function normalize(raw: string): string {
 return raw.replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').normalize('NFC')
  .replace(/[০-৯]/gu, value => String(value.charCodeAt(0) - 0x09e6))
  .replace(/[\u00A0\u202F]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function validDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
function asDate(value: bigint): Date { return new Date(Number(value / 1000n)); }
function asMicros(value: Date): bigint | null { return validDate(value) ? BigInt(value.getTime()) * 1000n : null; }
function utcWall(parts: Parts): number | null {
 if (!Number.isInteger(parts.year) || parts.year < 1900 || parts.year > 9999 || parts.month < 1 || parts.month > 12
  || parts.day < 1 || parts.day > 31 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59
  || parts.second < 0 || parts.second > 59) return null;
 const value = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
 const date = new Date(value);
 return date.getUTCFullYear() === parts.year && date.getUTCMonth() + 1 === parts.month && date.getUTCDate() === parts.day ? value : null;
}
function formatter(timeZone: string): Intl.DateTimeFormat | null {
 try { return new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
 catch { return null; }
}
function localParts(value: number, format: Intl.DateTimeFormat): Parts {
 const fields = Object.fromEntries(format.formatToParts(new Date(value)).map(part => [part.type, part.value]));
 return { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day), hour: Number(fields.hour), minute: Number(fields.minute), second: Number(fields.second) };
}
/** Find all valid UTC mappings; reject DST gaps and ambiguous repeated local times. */
function zonedUtc(parts: Parts, timeZone: string): number | null {
 const wall = utcWall(parts);
 const format = formatter(timeZone);
 if (wall === null || !format) return null;
 const offsets = new Set<number>();
 for (const delta of [-36, -12, 0, 12, 36]) {
  const probe = wall + delta * 60 * 60 * 1000;
  const represented = utcWall(localParts(probe, format));
  if (represented !== null) offsets.add(represented - probe);
 }
 const candidates = [...offsets].map(offset => wall - offset).filter(candidate => {
  const local = localParts(candidate, format);
  return (Object.keys(parts) as (keyof Parts)[]).every(key => parts[key] === local[key]);
 });
 return candidates.length === 1 ? candidates[0] : null;
}
function offsetMinutes(zone: string): number | null {
 if (/^(z|utc|gmt)$/iu.test(zone)) return 0;
 const match = zone.match(/^(?:utc|gmt)?\s*([+-])(\d{2}):?(\d{2})$/iu);
 if (!match) return null;
 const hour = Number(match[2]), minute = Number(match[3]);
 if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return null;
 return (match[1] === '-' ? -1 : 1) * (hour * 60 + minute);
}
function nextDay(parts: Parts): Parts {
 const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
 return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0 };
}
function calendar(parts: Parts, zone: string, fraction: string | undefined, precision: 'day' | 'minute' | 'second'): Parsed | null {
 const wall = utcWall(parts);
 if (wall === null) return null;
 const offset = offsetMinutes(zone);
 if (offset === null && /^(?:(?:utc|gmt)\s*)?[+-]/iu.test(zone)) return null;
 const timestamp = offset === null ? zonedUtc(parts, zone) : wall - offset * 60_000;
 if (timestamp === null) return null;
 const lower = BigInt(timestamp) * 1000n + BigInt((fraction ?? '').padEnd(6, '0') || '0');
 let upper = lower;
 if (precision === 'day') {
  const next = nextDay(parts);
  const nextWall = utcWall(next);
  const nextTimestamp = offset === null ? zonedUtc(next, zone) : nextWall === null ? null : nextWall - offset * 60_000;
  if (nextTimestamp === null) return null;
  upper = BigInt(nextTimestamp) * 1000n - MICROSECOND;
 } else if (precision === 'minute') upper += MINUTE - MICROSECOND;
 return { published: lower, lower, upper, precision: fraction ? 'fractional-second' : precision, timeZone: zone };
}

function parse(raw: string, observedAt: Date, assumedZone: string): { value: Parsed | null; reason: string | null } {
 let text = normalize(raw);
 if (!text || text.length > 1000) return { value: null, reason: 'Missing or oversized publication date.' };
 if (/\b(?:dateModified|lastmod|modified|updated)\b|হালনাগাদ|আপডেট/iu.test(text))
  return { value: null, reason: 'Modification dates are not publication evidence.' };
 text = text.replace(/^(?:published(?:\s+(?:at|on))?|publication(?:\s+(?:date|time))?|প্রকাশিত|প্রকাশ|প্রকাশের সময়)\s*[:：]?\s*/iu, '')
  .replace(/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার|রবিবার)\s*,?\s*/iu, '');
 const relative = text.match(/^(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|সেকেন্ড|মিনিট|ঘণ্টা|ঘন্টা|দিন)\s*(?:ago|আগে|পূর্বে)$/iu);
 if (relative) {
  const observed = asMicros(observedAt), count = Number(relative[1]);
  if (observed === null || !Number.isSafeInteger(count) || count > 1_000_000) return { value: null, reason: 'Invalid relative-date observation or quantity.' };
  const unit = relative[2].toLowerCase();
  const size = /^(seconds?|secs?|সেকেন্ড)$/u.test(unit) ? SECOND
   : /^(minutes?|mins?|মিনিট)$/u.test(unit) ? MINUTE : /^(hours?|hrs?|ঘণ্টা|ঘন্টা)$/u.test(unit) ? HOUR : DAY;
  // Publishers round, floor or ceil their labels. Include one unit on either side.
  const elapsed = BigInt(count) * size;
  return { value: { published: observed - elapsed, lower: observed - elapsed - size, upper: observed - (count > 0 ? elapsed - size : 0n), precision: `relative-${size === SECOND ? 'second' : size === MINUTE ? 'minute' : size === HOUR ? 'hour' : 'day'}`, timeZone: null }, reason: null };
 }

 // Only explicit, unambiguous timezone identifiers are accepted. BST/CST/IST are ambiguous.
 text = text.replace(/\(([^()]*)\)\s*$/u, ' $1').trim();
 let zone = assumedZone || 'Asia/Dhaka';
 const explicitZone = text.match(/\s*(Z|(?:UTC|GMT)(?:\s*[+-]\d{2}:?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|বাংলাদেশ(?:ি)?\s+সময়|ঢাকা\s+সময়)\s*$/iu);
 if (explicitZone) {
  zone = /বাংলাদেশ|ঢাকা/u.test(explicitZone[1]) ? 'Asia/Dhaka' : explicitZone[1];
  text = text.slice(0, explicitZone.index).trim();
 }
 text = text.replace(/\s*,\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
 let year: number, month: number, day: number, clock: string | undefined;
 const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](.+))?$/u);
 const dayFirst = text.match(/^(\d{1,2})[\s-]+([\p{L}\p{M}]+)\.?[\s-]+(\d{4})(?:\s+(.+))?$/u);
 const monthFirst = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2})\s+(\d{4})(?:\s+(.+))?$/u);
 if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); clock = iso[4]; }
 else if (dayFirst) { day = Number(dayFirst[1]); month = months[dayFirst[2].toLowerCase()]; year = Number(dayFirst[3]); clock = dayFirst[4]; }
 else if (monthFirst) { month = months[monthFirst[1].toLowerCase()]; day = Number(monthFirst[2]); year = Number(monthFirst[3]); clock = monthFirst[4]; }
 else return { value: null, reason: 'Unrecognized or ambiguous publication date.' };
 if (!month) return { value: null, reason: 'Unknown Gregorian month.' };
 let hour = 0, minute = 0, second = 0, fraction: string | undefined;
 let precision: 'day' | 'minute' | 'second' = 'day';
 if (clock) {
  const time = clock.match(/^(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2})(?:\.(\d{1,6}))?)?\s*(am|pm|a\.m\.|p\.m\.|পূর্বাহ্ন|অপরাহ্ন)?$/iu);
  if (!time) return { value: null, reason: 'Unrecognized clock or timezone.' };
  hour = Number(time[1]); minute = Number(time[2]); second = Number(time[3] ?? 0); fraction = time[4];
  precision = time[3] ? 'second' : 'minute';
  if (time[5]) {
   if (hour < 1 || hour > 12) return { value: null, reason: 'Invalid twelve-hour clock.' };
   hour = hour % 12 + (/^(pm|p\.m\.|অপরাহ্ন)$/iu.test(time[5]) ? 12 : 0);
  }
 }
 const value = calendar({ year, month, day, hour, minute, second }, zone, fraction, precision);
 return { value, reason: value ? null : 'Invalid calendar date, timezone, or ambiguous local clock.' };
}

function parsedEvidence(evidence: DateEvidence, observedAt: Date, timeZone: string): ParsedDateEvidence {
 const parsed = parse(evidence.raw, evidence.observedAt ?? observedAt, timeZone);
 const value = parsed.value;
 return { ...evidence, publishedAt: value ? asDate(value.published) : null, lowerBound: value ? asDate(value.lower) : null,
  upperBound: value ? asDate(value.upper) : null, publishedAtMicros: value?.published.toString() ?? null,
  lowerBoundMicros: value?.lower.toString() ?? null, upperBoundMicros: value?.upper.toString() ?? null,
  precision: value?.precision ?? null, timeZone: value?.timeZone ?? null, reason: parsed.reason };
}

export function resolvePublication(evidence: DateEvidence[], options: { observedAt: Date; timeZone: string }): PublicationResolution {
 const parsed = evidence.map(item => parsedEvidence(item, options.observedAt, options.timeZone));
 const usable = parsed.filter(item => item.publishedAtMicros !== null).sort((a, b) => rank[a.source] - rank[b.source]);
 const selected = usable[0];
 if (!selected) return { publishedAt: null, lowerBound: null, upperBound: null, publishedAtMicros: null,
  lowerBoundMicros: null, upperBoundMicros: null, confidence: 'unverified', precision: null,
  reason: 'No reliable publication date was found.', evidence: parsed };
 const lower = usable.reduce((value, item) => BigInt(item.lowerBoundMicros!) > value ? BigInt(item.lowerBoundMicros!) : value, BigInt(selected.lowerBoundMicros!));
 const upper = usable.reduce((value, item) => BigInt(item.upperBoundMicros!) < value ? BigInt(item.upperBoundMicros!) : value, BigInt(selected.upperBoundMicros!));
 const conflict = lower > upper;
 return { publishedAt: selected.publishedAt, lowerBound: selected.lowerBound, upperBound: selected.upperBound,
  publishedAtMicros: selected.publishedAtMicros, lowerBoundMicros: selected.lowerBoundMicros, upperBoundMicros: selected.upperBoundMicros,
  confidence: conflict ? 'unverified' : 'verified', precision: selected.precision,
  reason: conflict ? 'Conflicting publication dates require review.' : null, evidence: parsed };
}

/** Dynamic inclusive rolling window. Discovery time never influences eligibility. */
export function isCurrentPublication(publication: PublicationResolution, now: Date | string): boolean {
 let instant: bigint | null;
 if (typeof now === 'string') {
  const parsed = parse(now, new Date(0), 'UTC');
  instant = parsed.value && parsed.value.precision !== 'day' && parsed.value.precision !== 'minute' ? parsed.value.published : null;
 } else instant = asMicros(now);
 if (instant === null || publication.confidence !== 'verified' || !publication.publishedAt || !publication.lowerBound || !publication.upperBound) return false;
 const published = publication.publishedAtMicros !== null ? BigInt(publication.publishedAtMicros) : asMicros(publication.publishedAt);
 const lower = publication.lowerBoundMicros !== null ? BigInt(publication.lowerBoundMicros) : asMicros(publication.lowerBound);
 const upper = publication.upperBoundMicros !== null ? BigInt(publication.upperBoundMicros) : asMicros(publication.upperBound);
 return published !== null && lower !== null && upper !== null && lower <= published && published <= upper
  && lower >= instant - DAY && upper <= instant;
}

/** Use these strings for timestamptz writes so sub-millisecond precision is retained. */
export function publicationTimestamp(publication: PublicationResolution, field: 'published' | 'lower' | 'upper'): string | null {
 const value = field === 'published' ? publication.publishedAtMicros : field === 'lower' ? publication.lowerBoundMicros : publication.upperBoundMicros;
 if (value === null) return null;
 const micros = BigInt(value);
 const wholeMilliseconds = (micros - ((micros % 1000n + 1000n) % 1000n)) / 1000n;
 const iso = new Date(Number(wholeMilliseconds)).toISOString();
 const fractionalSecond = ((micros % SECOND + SECOND) % SECOND).toString().padStart(6, '0');
 return iso.replace(/\.\d{3}Z$/u, `.${fractionalSecond}Z`);
}
