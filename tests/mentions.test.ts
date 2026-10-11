import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilters } from '../apps/web/lib/mentions';
import { visibleMentions, inTab, tabCounts, dhakaTime, highlightParts, type Mention } from '../apps/web/lib/mention-view';
test('dashboard defaults and explicit history; reject invalid windows, statuses, sources and identifiers',()=>{
 assert.deepEqual(parseFilters({}),{hours:24,older:false,tab:'new',keyword:undefined,site:undefined,source:undefined,status:undefined});
 for(const hours of ['6','12','24'])assert.equal(parseFilters({hours}).hours,Number(hours));
 assert.equal(parseFilters({older:'true'}).older,true);
 for(const params of [{hours:'48'},{older:'false'},{tab:'unknown'},{status:'unknown'},{source:'unknown'},{keyword:'invalid'},{site:'invalid'}])assert.throws(()=>parseFilters(params));
});
test('server aligned expiry includes recent unverified cards and retains them in Date unverified after cutoff',()=>{
 const row={id:'one',status:'new',unverified:false,in_main_feed:true,expires_at:1000} as Mention;
 const flagged={...row,id:'two',status:'flagged' as const,expires_at:2000};
 const unverified={...row,id:'three',unverified:true,expires_at:1000};
 assert.deepEqual(tabCounts(visibleMentions([row,flagged,unverified],1000),1000),{new:2,all:3,flagged:1,unverified:1});
 assert.deepEqual(tabCounts(visibleMentions([row,flagged,unverified],1001),1001),{new:0,all:1,flagged:1,unverified:1});
 assert.deepEqual(tabCounts(visibleMentions([row,flagged,unverified],100000),100000),{new:0,all:0,flagged:0,unverified:1});
 assert.equal(inTab(unverified,'unverified',100000),true);
 assert.equal(visibleMentions([{...row,expires_at:null}],100000).length,1);
});
test('old unverified items stay in their date tab and history without guessed publication affecting visibility',()=>{
 const old={id:'old',status:'new',unverified:true,in_main_feed:false,expires_at:1000,published_at:'2099-01-01T00:00:00Z'} as Mention;
 assert.equal(inTab(old,'new',2000),false);
 assert.equal(inTab(old,'all',2000),false);
 assert.equal(inTab(old,'unverified',2000),true);
 const history={...old,in_main_feed:true,expires_at:null};
 assert.equal(inTab(history,'new',2000),true);
 assert.equal(inTab(history,'all',2000),true);
 assert.equal(inTab(history,'unverified',2000),true);
 const flagged={...history,status:'flagged' as const};
 assert.deepEqual(tabCounts([history,flagged],2000),{new:1,all:2,flagged:1,unverified:2});
});
test('Dhaka display crosses UTC midnight; original Bangla and HTML-like excerpts stay plain text',()=>{
 assert.equal(dhakaTime('2026-10-10T20:00:00Z'),'11 Oct 2026, 02:00:00');
 assert.deepEqual(highlightParts({excerpt:'<b>ব্রা\u200bন্ড</b>',highlight_start:3,highlight_end:11} as never),['<b>','ব্রা\u200bন্ড','</b>']);
});
