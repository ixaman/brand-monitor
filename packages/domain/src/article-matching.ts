import type { BooleanRule } from './keywords';

export const NORMALIZER_VERSION = 'bangla-nfc-1';
export const MATCHER_VERSION = 'literal-1';

// These formatting characters are frequently embedded in copied Bangla text.
// NFC maps ড়/ঢ়/য় and their base-letter + nukta spellings to the same form.
// Vowel marks, nukta, virama and punctuation remain meaningful and are kept.
const zeroWidth = /[\u200B-\u200D\u2060\uFEFF]/gu;
export function normalizeText(value: string): string {
 return value.replace(zeroWidth, '').normalize('NFC');
}

/** A conservative diagnostic, not a converter for legacy Bijoy font mappings. */
export function detectLegacyEncoding(...texts: string[]): boolean {
 return texts.some(text => {
  // Unicode Bangla alongside a Latin caption/footer is not itself garbled.
  const bangla = (text.match(/[\u0980-\u09FF]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  if (latin < 12 || bangla > Math.max(4, latin * 0.15)) return false;
  const artifacts = (text.match(/[†‡š›œ¯˜¶µ¦]/gu) ?? []).length;
  const mappedClusters = (text.match(/(?:cÖ|[bg]š¿|‡`|v‡|†k|¯\^|wfbœ|wZô|ms¯)/gu) ?? []).length;
  if ((artifacts >= 3 && mappedClusters >= 2) || (artifacts >= 2 && mappedClusters >= 3)) return true;
  if ((text.match(/à[¦§]/gu) ?? []).length >= 4) return true;
  // A few common entirely ASCII Bijoy words offer evidence when glyphs are absent.
  // Require several independent signatures; normal English is never diagnosed
  // merely for lacking Bangla characters or for using mixed letter case.
  const asciiSignatures = new Set(text.match(/\b(?:Avwg|evsjvq?|MvB|RvZxq|nvwmbv)\b/gu) ?? []);
  return asciiSignatures.size >= 3;
 });
}

export type KeywordRule = {
 term: string;
 aliases: readonly string[];
 exclusions: readonly string[];
 match_type: 'exact' | 'any' | 'boolean';
 boolean_ast: BooleanRule | null;
};
export type ArticleText = { title: string; body: string };
export type KeywordMatch = {
 matchedIn: 'title' | 'body';
 excerpt: string;
 matchedTerm: string;
 // UTF-16 offsets in the original title/body, suitable for String.slice().
 start: number;
 end: number;
};
type NormalizedText = { value: string; starts: number[]; ends: number[]; raw: string };
const graphemes = new Intl.Segmenter('bn', { granularity: 'grapheme' });
const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

function normalizedOffsets(raw: string): NormalizedText {
 let cleaned = '';
 const sourceStarts: number[] = [], sourceEnds: number[] = [];
 let rawIndex = 0;
 // Clean before segmenting: a zero-width separator must not stop NFC composing
 // the surrounding base letter and combining mark (e.g. e + ZWSP + acute).
 for (const character of raw) {
  if (!/[\u200B-\u200D\u2060\uFEFF]/u.test(character)) {
   cleaned += character;
   for (let unit = 0; unit < character.length; unit++) {
    sourceStarts.push(rawIndex); sourceEnds.push(rawIndex + character.length);
   }
  }
  rawIndex += character.length;
 }
 let value = '';
 const starts: number[] = [], ends: number[] = [];
 for (const segment of graphemes.segment(cleaned)) {
  const normalized = segment.segment.normalize('NFC').toLowerCase().normalize('NFC');
  value += normalized;
  for (let unit = 0; unit < normalized.length; unit++) {
   starts.push(sourceStarts[segment.index]);
   ends.push(sourceEnds[segment.index + segment.segment.length - 1]);
  }
 }
 return { value, starts, ends, raw };
}

function folded(value: string): string { return normalizeText(value).toLowerCase().normalize('NFC'); }
function previousCharacter(value: string, index: number): string {
 if (!index) return '';
 const end = value.charCodeAt(index - 1);
 return value.slice(index - (end >= 0xDC00 && end <= 0xDFFF ? 2 : 1), index);
}
function nextCharacter(value: string, index: number): string {
 if (index >= value.length) return '';
 const start = value.charCodeAt(index);
 return value.slice(index, index + (start >= 0xD800 && start <= 0xDBFF ? 2 : 1));
}
function excerpt(raw: string, start: number, end: number): string {
 let left = Math.max(0, start - 90), right = Math.min(raw.length, end + 90);
 if (left > 0 && /[\uDC00-\uDFFF]/u.test(raw[left])) left--;
 if (right < raw.length && /[\uDC00-\uDFFF]/u.test(raw[right])) right++;
 return `${left ? '…' : ''}${raw.slice(left, right)}${right < raw.length ? '…' : ''}`;
}

function occurrences(text: NormalizedText, term: string, matchedIn: KeywordMatch['matchedIn'], exact: boolean): KeywordMatch[] {
 const needle = folded(term);
 if (!needle) return [];
 const result: KeywordMatch[] = [];
 let offset = 0;
 while (offset <= text.value.length - needle.length) {
  const start = text.value.indexOf(needle, offset);
  if (start < 0) break;
  const end = start + needle.length;
  // Include combining marks in word boundaries: a short keyword must not
  // match inside a longer Bangla word or part of a conjunct/vowel sequence.
  if (!exact || ((!wordCharacter.test(previousCharacter(text.value, start))) && (!wordCharacter.test(nextCharacter(text.value, end))))) {
   const rawStart = text.starts[start], rawEnd = text.ends[end - 1];
   result.push({ matchedIn, excerpt: excerpt(text.raw, rawStart, rawEnd), matchedTerm: term, start: rawStart, end: rawEnd });
  }
  offset = start + Math.max(1, needle.length);
 }
 return result;
}

/** Evaluate validated rules against both fields. Exclusions veto across fields. */
export function matchKeyword(article: ArticleText, rule: KeywordRule): KeywordMatch[] {
 if (detectLegacyEncoding(article.title, article.body)) return [];
 const title = normalizedOffsets(article.title), body = normalizedOffsets(article.body);
 const hits = (term: string, exact = false) => [
  ...occurrences(title, term, 'title', exact), ...occurrences(body, term, 'body', exact),
 ];
 if (rule.exclusions.some(term => hits(term).length > 0)) return [];
 const alternatives = [...new Map([rule.term, ...rule.aliases].map(term => [folded(term), term])).values()];
 let matches: KeywordMatch[];
 if (rule.match_type !== 'boolean') {
  matches = alternatives.flatMap(term => hits(term, rule.match_type === 'exact'));
 } else {
  if (!rule.boolean_ast) return [];
  type Evaluation = { satisfied: boolean; evidence: KeywordMatch[] };
  // Push negation down the tree, so double NOT and De Morgan expressions retain
  // positive literal evidence while true NOT-only rules cannot create mentions.
  function evaluate(node: BooleanRule, negated = false): Evaluation {
   if (node.op === 'not') return evaluate(node.arg, !negated);
   if (node.op === 'literal') {
    const terms = folded(node.value) === folded(rule.term) ? alternatives : [node.value];
    const evidence = terms.flatMap(term => hits(term));
    return { satisfied: negated ? evidence.length === 0 : evidence.length > 0, evidence: negated ? [] : evidence };
   }
   const children = node.args.map(child => evaluate(child, negated));
   const effectiveOp = negated ? (node.op === 'and' ? 'or' : 'and') : node.op;
   const satisfied = effectiveOp === 'and' ? children.every(child => child.satisfied) : children.some(child => child.satisfied);
   return { satisfied, evidence: satisfied ? children.filter(child => child.satisfied).flatMap(child => child.evidence) : [] };
  }
  const evaluation = evaluate(rule.boolean_ast);
  matches = evaluation.satisfied ? evaluation.evidence : [];
 }
 // Repeated AST leaves and equivalent aliases must not duplicate one piece of evidence.
 return [...new Map(matches.map(match => [`${match.matchedIn}:${match.start}:${match.end}`, match])).values()]
  .sort((a, b) => (a.matchedIn === b.matchedIn ? a.start - b.start : a.matchedIn === 'title' ? -1 : 1));
}
