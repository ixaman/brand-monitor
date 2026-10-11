import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 detectLegacyEncoding, matchKeyword, normalizeText, type KeywordRule,
} from '../packages/domain/src/article-matching';
import { normalizeKeyword, validateBooleanRule } from '../packages/domain/src/keywords';

const baseRule: KeywordRule = {
 term: 'ব্র্যান্ড', aliases: ['Brand'], exclusions: [], match_type: 'exact', boolean_ast: null,
};
function rule(overrides: Partial<KeywordRule> = {}): KeywordRule { return { ...baseRule, ...overrides }; }

test('normalization composes accents and Bangla forms while retaining meaningful vowel and conjunct marks', () => {
 assert.equal(normalizeText('ব্\u200Dর্যা\u200Bন্ড\u200C\u2060\uFEFF'), normalizeText('ব্র্যান্ড'));
 assert.equal(normalizeText('e\u200B\u0301'), 'é');
 for (const [precomposed, decomposed] of [['বড়', 'বড়'], ['আষাঢ়', 'আষাঢ়'], ['সময়', 'সময়']]) {
  assert.equal(normalizeText(precomposed), normalizeText(decomposed));
  assert.equal(normalizeText(precomposed), normalizeText(precomposed.normalize('NFD')));
 }
 assert.equal(normalizeText('ক্ষতি, রূপ'), 'ক্ষতি, রূপ');
 assert.notEqual(normalizeText('রূপ'), normalizeText('রুপ'));
 assert.notEqual(normalizeText('য'), normalizeText('য়'));
 assert.equal(normalizeKeyword(' Brand\u2060 '), 'Brand');
});

test('exact matches term and aliases in title and body with Unicode word/phrase boundaries', () => {
 const article = { title: 'ব্র্যান্ডের পরে ব্র্যান্ড ঘোষণা', body: 'A Brand-new product. rebranding and BRAND.' };
 const matches = matchKeyword(article, baseRule);
 assert.equal(matches.length, 3);
 assert.deepEqual(matches.map(match => match.matchedIn), ['title', 'body', 'body']);
 assert.deepEqual(matches.map(match => article[match.matchedIn].slice(match.start, match.end)), ['ব্র্যান্ড', 'Brand', 'BRAND']);
 assert.equal(matchKeyword({ title: 'ক্ষতিতে', body: '' }, rule({ term: 'ক্ষতি', aliases: [] })).length, 0);
 assert.equal(matchKeyword({ title: 'Éclair আর é', body: '' }, rule({ term: 'é', aliases: [] })).length, 1);
 assert.equal(matchKeyword({ title: '📣 Client X!', body: '' }, rule({ term: 'client x', aliases: [] })).length, 1);
 assert.equal(matchKeyword({ title: 'Client XYZ', body: '' }, rule({ term: 'Client X', aliases: [] })).length, 0);
 assert.equal(matchKeyword({ title: '𝒜Brand', body: '' }, rule({ term: 'Brand', aliases: [] })).length, 0);
 assert.equal(matchKeyword({ title: 'Brand_123', body: '' }, rule({ term: 'Brand', aliases: [] })).length, 0);
});

test('any matches literal substrings and never treats metacharacters as a regular expression', () => {
 const matches = matchKeyword({ title: 'preBRANDing', body: 'literal a+b and [x]' }, rule({ match_type: 'any' }));
 assert.equal(matches.length, 1);
 assert.equal(matches[0].start, 3);
 assert.equal(matches[0].end, 8);
 assert.equal(matchKeyword({ title: 'aaab', body: 'a+b' }, rule({ term: 'a+b', aliases: [], match_type: 'any' })).length, 1);
 assert.equal(matchKeyword({ title: 'axxb', body: '' }, rule({ term: 'a.*b', aliases: [], match_type: 'any' })).length, 0);
});

test('normalizes both article and keywords with original-text offsets and excerpts', () => {
 const title = '📣 ব্\u200Dর্যা\u200Bন্ড ও বড় সংবাদ';
 const matches = matchKeyword({ title, body: 'Café new product' }, rule({ aliases: ['বড়', 'CAFÉ'] }));
 assert.equal(matches.length, 3);
 assert.equal(title.slice(matches[0].start, matches[0].end), 'ব্\u200Dর্যা\u200Bন্ড');
 assert.equal(title.slice(matches[1].start, matches[1].end), 'বড়');
 assert.equal('Café new product'.slice(matches[2].start, matches[2].end), 'Café');
 assert.equal(matches[0].excerpt, title);
 assert.equal(matchKeyword({ title: 'সময়', body: '' }, rule({ term: 'সময়', aliases: [] })).length, 1);
 const separatedAccent = 'before e\u200B\u0301 after';
 const accent = matchKeyword({ title: separatedAccent, body: '' }, rule({ term: 'É', aliases: [] }))[0];
 assert.equal(separatedAccent.slice(accent.start, accent.end), 'e\u200B\u0301');
});

test('literal exclusions in either title or body veto matches, case and Bangla normalization included', () => {
 const excludedRule = rule({ exclusions: ['চাকরি', 'Job Offer', 'বড়'] });
 assert.equal(matchKeyword({ title: 'Brand updates', body: 'চাকরি বিজ্ঞপ্তি' }, excludedRule).length, 0);
 assert.equal(matchKeyword({ title: 'job offer', body: 'Brand updates' }, excludedRule).length, 0);
 assert.equal(matchKeyword({ title: 'বড় খবর', body: 'ব্র্যান্ড' }, excludedRule).length, 0);
 assert.equal(matchKeyword({ title: 'ব্র্যান্ড খবর', body: 'সফলতা' }, excludedRule).length, 1);
 // Exclusions are literal substring vetoes in every mode.
 assert.equal(matchKeyword({ title: 'Brand career', body: 'myjobs' }, rule({ exclusions: ['jobs'] })).length, 0);
});

test('Boolean AND/OR/NOT combines fields and term aliases without bypassing constraints', () => {
 const ast = validateBooleanRule({ op: 'and', args: [
  { op: 'literal', value: 'ব্র্যান্ড' },
  { op: 'or', args: [{ op: 'literal', value: 'লাভ' }, { op: 'literal', value: 'profit' }] },
  { op: 'not', arg: { op: 'literal', value: 'চাকরি' } },
 ] });
 const boolean = rule({ match_type: 'boolean', boolean_ast: ast });
 const matches = matchKeyword({ title: 'Brand সংবাদ', body: 'প্রতিষ্ঠানের লাভ বেড়েছে' }, boolean);
 assert.deepEqual(matches.map(match => match.matchedTerm), ['Brand', 'লাভ']);
 assert.deepEqual(matches.map(match => match.matchedIn), ['title', 'body']);
 assert.equal(matchKeyword({ title: 'Brand', body: '' }, boolean).length, 0);
 assert.equal(matchKeyword({ title: 'Brand', body: 'profit এবং চাকরি' }, boolean).length, 0);
 assert.equal(matchKeyword({ title: 'Unrelated company profit', body: '' }, boolean).length, 0);
});

test('Boolean NOT-only results need positive evidence, including true OR branches', () => {
 const notOnly = rule({ match_type: 'boolean', boolean_ast: { op: 'not', arg: { op: 'literal', value: 'চাকরি' } } });
 assert.deepEqual(matchKeyword({ title: 'অন্য সংবাদ', body: '' }, notOnly), []);
 const orNot = rule({ match_type: 'boolean', boolean_ast: { op: 'or', args: [
  { op: 'literal', value: 'ব্র্যান্ড' }, { op: 'not', arg: { op: 'literal', value: 'চাকরি' } },
 ] } });
 assert.deepEqual(matchKeyword({ title: 'অন্য সংবাদ', body: '' }, orNot), []);
 assert.equal(matchKeyword({ title: 'Brand', body: '' }, orNot).length, 1);
 const doubleNot = rule({ match_type: 'boolean', boolean_ast: {
  op: 'not', arg: { op: 'not', arg: { op: 'literal', value: 'ব্র্যান্ড' } },
 } });
 assert.equal(matchKeyword({ title: 'Brand', body: '' }, doubleNot).length, 1);
 assert.equal(matchKeyword({ title: 'অন্য সংবাদ', body: '' }, doubleNot).length, 0);
});

test('repeated AST leaves and equivalent aliases do not duplicate one match', () => {
 const exact = rule({ term: 'বড়', aliases: ['বড়', 'বড়'] });
 assert.equal(matchKeyword({ title: 'বড় বড়', body: '' }, exact).length, 2);
 const boolean = rule({ match_type: 'boolean', boolean_ast: { op: 'or', args: [
  { op: 'literal', value: 'ব্র্যান্ড' }, { op: 'literal', value: 'ব্র্যান্ড' },
 ] } });
 assert.equal(matchKeyword({ title: 'Brand', body: '' }, boolean).length, 1);
});

test('Bijoy-style pages are diagnosed without flagging readable Bangla or ordinary English', () => {
 assert.equal(detectLegacyEncoding('cÖavbgš¿x †kL nvwmbv evsjv‡`k †mev'), true);
 assert.equal(detectLegacyEncoding('cÖavbgš¿x †kL nvwmbv'), true);
 assert.equal(detectLegacyEncoding('Avwg evsjvq Mvb MvB'), true);
 assert.equal(detectLegacyEncoding('English news: Company ABC reported a 15% profit; © 2026, all rights reserved. ™'), false);
 assert.equal(detectLegacyEncoding('A reference to Avwg and evsjv alone is not enough'), false);
 assert.equal(detectLegacyEncoding('প্রধানমন্ত্রী দেশের উন্নয়ন নিয়ে কথা বলেন। কোম্পানির লাভ বেড়েছে।'), false);
 assert.equal(detectLegacyEncoding('Readable news', 'cÖavbgš¿x †kL nvwmbv evsjv‡`k'), true);
 assert.equal(matchKeyword({ title: 'Brand', body: 'cÖavbgš¿x †kL nvwmbv evsjv‡`k' }, baseRule).length, 0);
});
