import { normalizeText } from './article-matching';

// Server domain validation; shares the slice 3 article text normalizer.
export class ValidationError extends Error {}
export function normalizeKeyword(value: string) {
 return normalizeText(value).trim();
}
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an object.');
 return value as Record<string, unknown>;
}
function literal(value: unknown, label: string, max = 500): string {
 if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
 const result = normalizeKeyword(value);
 if (!result || result.length > max) throw new ValidationError(`${label} must contain 1–${max} characters.`);
 return result;
}
export type BooleanRule = { op: 'literal'; value: string } | { op: 'and' | 'or'; args: BooleanRule[] } | { op: 'not'; arg: BooleanRule };
export function validateBooleanRule(value: unknown): BooleanRule {
 let nodes = 0;
 function visit(value: unknown, depth: number): BooleanRule {
  if (++nodes > 100 || depth > 10) throw new ValidationError('Boolean rule is too large or deep.');
  const rule = object(value);
  const allowed = rule.op === 'literal' ? ['op','value'] : rule.op === 'not' ? ['op','arg'] : ['op','args'];
  if (Object.keys(rule).some(key => !allowed.includes(key))) throw new ValidationError('Unknown Boolean rule field.');
  if (rule.op === 'literal') return { op: 'literal', value: literal(rule.value, 'Boolean literal') };
  if (rule.op === 'not') return { op: 'not', arg: visit(rule.arg, depth + 1) };
  if ((rule.op === 'and' || rule.op === 'or') && Array.isArray(rule.args) && rule.args.length >= 2 && rule.args.length <= 20)
   return { op: rule.op, args: rule.args.map(arg => visit(arg, depth + 1)) };
  throw new ValidationError('Use literal, not, or and/or with 2–20 arguments.');
 }
 return visit(value, 0);
}
function list(value: unknown, label: string): string[] {
 if (!Array.isArray(value) || value.length > 50) throw new ValidationError(`${label} must be an array of at most 50 terms.`);
 return [...new Set(value.map(item => literal(item, label)))];
}
function active(value: unknown) {
 if (typeof value !== 'boolean') throw new ValidationError('Active must be a boolean.');
 return value;
}
export function validateClient(value: unknown) {
 const input = object(value);
 if (typeof input.notes !== 'string' || input.notes.length > 10000) throw new ValidationError('Notes must be text of at most 10000 characters.');
 return { name: literal(input.name, 'Client name', 200), notes: input.notes.trim(), active: active(input.active) };
}
export function validateKeyword(value: unknown) {
 const input = object(value);
 if (!['exact','any','boolean'].includes(input.match_type as string)) throw new ValidationError('Invalid match type.');
 if (input.match_type !== 'boolean' && input.boolean_ast != null) throw new ValidationError('Only Boolean rules accept an expression.');
 return { term: literal(input.term, 'Term'), aliases: list(input.aliases, 'Aliases'), exclusions: list(input.exclusions, 'Exclusions'),
  match_type: input.match_type as 'exact' | 'any' | 'boolean',
  boolean_ast: input.match_type === 'boolean' ? validateBooleanRule(input.boolean_ast) : null, active: active(input.active) };
}
