import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrentPublication, publicationTimestamp, resolvePublication, type DateEvidence } from '../packages/domain/src/article-dates';

const observation = new Date('2026-10-11T16:00:00Z');
function resolve(raw: string, source: DateEvidence['source'] = 'visible', observedAt = observation, timeZone = 'Asia/Dhaka') {
 return resolvePublication([{ raw, source }], { observedAt, timeZone });
}

test('ISO offsets, no-zone Dhaka assumption, UTC storage and late indexing', () => {
 for (const date of ['2026-10-11T18:30:00+06:00', '2026-10-11T12:30:00Z', '2026-10-11T18:30:00', '2026-10-11T08:30:00-0400']) {
  const publication = resolve(date, 'jsonld');
  assert.equal(publication.confidence, 'verified');
  assert.equal(publication.publishedAt?.toISOString(), '2026-10-11T12:30:00.000Z');
  assert.equal(isCurrentPublication(publication, observation), true);
 }
 assert.equal(resolve('2026-10-11T12:30:00', 'time', observation, 'UTC').publishedAt?.toISOString(), '2026-10-11T12:30:00.000Z');
 assert.equal(resolve('2026-10-11T12:30:00Z', 'time', observation, 'invalid/zone').confidence, 'verified');
 assert.equal(resolve('2026-10-11T12:30:00', 'time', observation, 'invalid/zone').confidence, 'unverified');
 assert.equal(isCurrentPublication(resolve('2026-10-09T12:30:00Z'), observation), false);
});

test('rolling 24-hour inclusive cutoff, one microsecond before/after, future and live expiry', () => {
 const now = '2026-10-11T16:00:00.123456Z';
 assert.equal(isCurrentPublication(resolve('2026-10-10T16:00:00.123456Z'), now), true);
 assert.equal(isCurrentPublication(resolve('2026-10-10T16:00:00.123455Z'), now), false);
 assert.equal(isCurrentPublication(resolve('2026-10-10T16:00:00.123457Z'), now), true);
 assert.equal(isCurrentPublication(resolve(now), now), true);
 assert.equal(isCurrentPublication(resolve('2026-10-11T16:00:00.123457Z'), now), false);
 assert.equal(publicationTimestamp(resolve('2026-10-10T16:00:00.123456Z'), 'published'), '2026-10-10T16:00:00.123456Z');
 const cutoff = resolve('2026-10-10T16:00:00Z');
 assert.equal(isCurrentPublication(cutoff, observation), true);
 assert.equal(isCurrentPublication(cutoff, new Date(observation.getTime() + 1)), false);
 assert.equal(isCurrentPublication(resolve('unknown'), observation), false);
 assert.equal(isCurrentPublication(cutoff, new Date('invalid')), false);
});

test('Dhaka midnight and UTC midnight have the same rolling window', () => {
 const midnightDhaka = new Date('2026-10-11T18:00:00Z');
 assert.equal(isCurrentPublication(resolve('2026-10-11T00:00:00+06:00'), midnightDhaka), true);
 assert.equal(isCurrentPublication(resolve('2026-10-11T00:00:00Z'), midnightDhaka), true);
 assert.equal(isCurrentPublication(resolve('2026-10-11T00:00:00+06:00'), new Date('2026-10-12T00:00:00Z')), false);
 assert.equal(isCurrentPublication(resolve('2026-10-11T00:00:00Z'), new Date('2026-10-12T00:00:00Z')), true);
});

test('Bangla digits and Gregorian month names, NFC spelling, publication labels, spacing and 12-hour clocks', () => {
 for (const raw of ['প্রকাশ: ১১ অক্টোবর ২০২৬, ২১: ৫৩: ৫৯', '১১ অক্টোবর ২০২৬ ২১:৫৩:৫৯', 'Sunday, 11 October 2026 9:53:59 PM +0600', 'October 11, 2026 21:53:59 Asia/Dhaka']) {
  assert.equal(resolve(raw).publishedAt?.toISOString(), '2026-10-11T15:53:59.000Z', raw);
 }
 const names = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
 names.forEach((month, i) => {
  const expected = `2026-${String(i + 1).padStart(2, '0')}-11T06:00:00.000Z`;
  assert.equal(resolve(`১১ ${month} ২০২৬ ১২:০০:০০`).publishedAt?.toISOString(), expected);
  assert.equal(resolve(`১১ ${month.normalize('NFD')} ২০২৬ ১২:০০:০০`).publishedAt?.toISOString(), expected);
 });
 assert.equal(resolve('১১ অক্টোবর ২০২৬ ১২:০০:০০ পূর্বাহ্ন').publishedAt?.toISOString(), '2026-10-10T18:00:00.000Z');
 assert.equal(resolve('১১ অক্টোবর ২০২৬ ১২:০০:০০ অপরাহ্ন').publishedAt?.toISOString(), '2026-10-11T06:00:00.000Z');
 assert.equal(resolve('১১ অক্টোবর ২০২৬ ২১:৫৩:৫৯ বাংলাদেশ সময়').publishedAt?.toISOString(), '2026-10-11T15:53:59.000Z');
});

test('relative times preserve observation clock and include coarse rounding uncertainty', () => {
 for (const raw of ['২ ঘণ্টা আগে', '২ ঘন্টা আগে', '2 hours ago']) {
  const publication = resolve(raw);
  assert.equal(publication.publishedAt?.toISOString(), '2026-10-11T14:00:00.000Z');
  assert.equal(publication.lowerBound?.toISOString(), '2026-10-11T13:00:00.000Z');
  assert.equal(publication.upperBound?.toISOString(), '2026-10-11T15:00:00.000Z');
  assert.equal(isCurrentPublication(publication, observation), true);
 }
 const captured = new Date('2026-10-10T16:00:00Z');
 const delayed = resolvePublication([{ raw: '2 hours ago', source: 'feed', observedAt: captured }], { observedAt: observation, timeZone: 'Asia/Dhaka' });
 assert.equal(delayed.publishedAt?.toISOString(), '2026-10-10T14:00:00.000Z');
 assert.equal(isCurrentPublication(delayed, observation), false);
 assert.equal(isCurrentPublication(resolve('২৩ ঘণ্টা আগে'), observation), true);
 assert.equal(isCurrentPublication(resolve('২৪ ঘণ্টা আগে'), observation), false);
 assert.equal(resolve('৫ মিনিট আগে').publishedAt?.toISOString(), '2026-10-11T15:55:00.000Z');
 assert.equal(resolve('10 seconds ago').publishedAt?.toISOString(), '2026-10-11T15:59:50.000Z');
 assert.equal(resolve('১ দিন আগে').publishedAt?.toISOString(), '2026-10-10T16:00:00.000Z');
 assert.equal(resolve('yesterday').confidence, 'unverified');
 assert.equal(resolve('a few hours ago').confidence, 'unverified');
 assert.equal(resolve('1.5 hours ago').confidence, 'unverified');
 assert.equal(resolve('2 hours ago', 'visible', new Date('invalid')).confidence, 'unverified');
});

test('date-only and minute-only evidence never leaks across cutoff or into future', () => {
 const dateOnly = resolve('২০২৬-১০-১১');
 assert.equal(publicationTimestamp(dateOnly, 'lower'), '2026-10-10T18:00:00.000000Z');
 assert.equal(publicationTimestamp(dateOnly, 'upper'), '2026-10-11T17:59:59.999999Z');
 assert.equal(isCurrentPublication(dateOnly, observation), false);
 assert.equal(isCurrentPublication(dateOnly, new Date('2026-10-11T18:00:00Z')), true);
 assert.equal(isCurrentPublication(dateOnly, new Date('2026-10-11T18:00:00.001Z')), false);
 const minuteOnly = resolve('2026-10-11T16:00Z');
 assert.equal(publicationTimestamp(minuteOnly, 'upper'), '2026-10-11T16:00:59.999999Z');
 assert.equal(isCurrentPublication(minuteOnly, observation), false);
 assert.equal(isCurrentPublication(minuteOnly, new Date('2026-10-11T16:01:00Z')), true);
});

test('metadata priority preserves all evidence, rejects modification dates, and conservatively reports conflicts', () => {
 const options = { observedAt: observation, timeZone: 'Asia/Dhaka' };
 const date = '2026-10-11T14:41:07Z';
 const result = resolvePublication([
  { raw: '11 October 2026 20:41', source: 'visible' },
  { raw: date, source: 'feed' }, { raw: date, source: 'time' },
  { raw: date, source: 'opengraph' }, { raw: date, source: 'jsonld' },
 ], options);
 assert.equal(result.confidence, 'verified');
 assert.equal(result.precision, 'second');
 assert.equal(result.evidence.length, 5);
 assert.equal(result.evidence.find(item => item.source === 'jsonld')?.publishedAt?.toISOString(), result.publishedAt?.toISOString());
 const fallback = resolvePublication([{ raw: 'bad', source: 'jsonld' }, { raw: date, source: 'news-sitemap' }], options);
 assert.equal(fallback.confidence, 'verified');
 assert.equal(fallback.evidence[0].reason, 'Unrecognized or ambiguous publication date.');
 for (const raw of ['dateModified: 2026-10-11T14:41:07Z', 'lastmod: 2026-10-11T14:41:07Z', 'Updated: 11 October 2026 20:41', 'আপডেট: ১১ অক্টোবর ২০২৬ ২০:৪১']) {
  assert.equal(resolve(raw).confidence, 'unverified');
 }
 const conflicting = resolvePublication([{ raw: date, source: 'jsonld' }, { raw: '2026-10-10T14:41:07Z', source: 'opengraph' }], options);
 assert.equal(conflicting.confidence, 'unverified');
 assert.match(conflicting.reason!, /Conflicting/u);
 assert.equal(isCurrentPublication(conflicting, observation), false);
});

test('malformed, ambiguous calendars/timezones and DST clocks stay unverified', () => {
 for (const raw of ['2026-02-30T12:00:00Z', '2026-13-11T12:00:00Z', '2026-10-11T25:00:00Z', '2026-10-11T12:60:00Z', '2026-10-11T12:00:60Z', '2026-10-11T12:00:00+15:00', '2026-10-11T12:00:00+06:99', '2026-10-11T12:00:00 BST', '11/10/2026', '১১ বৈশাখ ১৪৩৩', '11 October 2026 13:00 PM', '2026-10-11T12:00:00.1234567Z']) {
  assert.equal(resolve(raw).confidence, 'unverified', raw);
 }
 assert.equal(resolve('2026-03-08T02:30:00', 'time', observation, 'America/New_York').confidence, 'unverified');
 assert.equal(resolve('2026-11-01T01:30:00', 'time', observation, 'America/New_York').confidence, 'unverified');
 assert.equal(resolve('2026-11-01T01:30:00-04:00').publishedAt?.toISOString(), '2026-11-01T05:30:00.000Z');
 assert.equal(resolve('Sun, 11 Oct 2026 14:41:07 GMT', 'feed').publishedAt?.toISOString(), '2026-10-11T14:41:07.000Z');
});
