import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeyword, validateKeyword, validateClient, validateBooleanRule, ValidationError } from '../packages/domain/src/keywords';
const rule = { term: 'ব্র্যান্ড', aliases: ['Brand'], exclusions: ['চাকরি'], match_type: 'exact', boolean_ast: null, active: true };
test('Bangla keyword normalization preserves marks, folds NFC equivalents and removes zero-width characters', () => {
 assert.equal(normalizeKeyword('  ব্\u200Dর্যা\u200Bন্ড\uFEFF '), 'ব্র্যান্ড');
 for (const term of ['বড়', 'আষাঢ়', 'সময়']) assert.equal(normalizeKeyword(term), normalizeKeyword(term.normalize('NFD')));
 assert.equal(normalizeKeyword('ক্ষতি'), 'ক্ষতি');
 assert.equal(normalizeKeyword('e\u200B\u0301'), 'é');
 const result = validateKeyword({ ...rule, term: ' ব্র্যা\u200Cন্ড ', aliases: [' Brand ', 'Brand', 'বড়', 'বড়'.normalize('NFD')] });
 assert.equal(result.term, 'ব্র্যান্ড');
 assert.deepEqual(result.aliases, ['Brand', normalizeKeyword('বড়')]);
 assert.deepEqual(result.exclusions, ['চাকরি']);
});
test('CRUD validation rejects blank terms, malformed lists, modes and inconsistent expressions', () => {
 for (const change of [{term:''}, {term:'\u200B'}, {term:'x'.repeat(501)}, {aliases:'a'}, {aliases:[null]}, {aliases:[' ']}, {aliases:Array(51).fill('a')}, {exclusions:[1]}, {active:'false'}, {match_type:'regex'}, {boolean_ast:{op:'literal',value:'x'}}, {match_type:'boolean'}])
  assert.throws(() => validateKeyword({...rule,...change}), ValidationError);
 assert.equal(validateKeyword({...rule,match_type:'any'}).match_type, 'any');
 assert.throws(() => validateClient({ name:' ', notes:'', active:true }), ValidationError);
 assert.throws(() => validateClient({ name:'x', notes:4, active:true }), ValidationError);
 assert.deepEqual(validateClient({name:' ক্লায়েন্ট ', notes:' notes ',active:false}), {name:'ক্লায়েন্ট'.normalize('NFC'),notes:'notes',active:false});
});
test('finite Boolean schema validates nested literal AND/OR/NOT and normalizes leaves', () => {
 const ast = {op:'and',args:[{op:'literal',value:' ব্র্যা\u200Bন্ড '},{op:'not',arg:{op:'or',args:[{op:'literal',value:'jobs'},{op:'literal',value:'চাকরি'}]}}]};
 const output = validateKeyword({...rule,match_type:'boolean',boolean_ast:ast});
 assert.equal(output.boolean_ast?.op, 'and');
 assert.deepEqual(validateBooleanRule({op:'literal',value:' ব্র্যা\u200Bন্ড '}), {op:'literal',value:'ব্র্যান্ড'});
 for (const invalid of [null, [], {op:'eval',value:'process.exit()'}, {op:'literal',value:''}, {op:'literal',value:'x',code:'x'}, {op:'not'}, {op:'and',args:[]}, {op:'or',args:[{op:'literal',value:'x'}]}, {op:'and',args:Array(21).fill({op:'literal',value:'x'})}])
  assert.throws(() => validateBooleanRule(invalid), ValidationError);
 let deep: unknown = {op:'literal',value:'x'};
 for(let i=0;i<11;i++) deep = {op:'not',arg:deep};
 assert.throws(() => validateBooleanRule(deep), ValidationError);
 const wide = {op:'or',args:Array(10).fill({op:'and',args:Array(10).fill({op:'literal',value:'x'})})};
 assert.throws(() => validateBooleanRule(wide), ValidationError);
});
