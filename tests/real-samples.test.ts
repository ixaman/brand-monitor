import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSampleDirectory, sampleSourceUrl } from '../scripts/check-samples';
import { extractArticle } from '../packages/domain/src/article-extraction';
import { publicationTimestamp, resolvePublication } from '../packages/domain/src/article-dates';

// The private HTML stays ignored. Short assertions identify body content and
// guard against extracting publisher navigation/recommendations instead.
const samples = [
 {file:'Bangladesh’s Rooppur plant achieves first controlled nuclear reaction.html',published:'2026-10-11T14:41:07.000000Z',marker:'Tk 1.39 trillion',minimumBody:5000},
 {file:'চুরি যাওয়া ল্যাপটপের অবস্থান জানালেন জার্মান পর্যটক, তবু কেন উদ্ধার হচ্ছে না.html',published:'2026-10-11T16:13:22.000000Z',marker:'ম্যাকবুক',minimumBody:3500},
 {file:'রিয়াদ বিমানবন্দরে আবার হামলা, টার্মিনালে আগুন.html',published:'2026-10-11T15:53:59.000000Z',marker:'পররাষ্ট্র মন্ত্রণালয়',minimumBody:1500},
 {file:'‘অল-রাউন্ড ডিউরেবল চ্যাম্পিয়ন’ রিয়েলমি সি১০০ উন্মোচন - সি নিউজ - প্রযুক্তির কণ্ঠস্বর.html',published:null,marker:'realme C100',minimumBody:2500},
];
for (const sample of samples) {
 const path = join(defaultSampleDirectory,sample.file);
 test(`optional private article sample: ${sample.file}`,{skip:existsSync(path) ? false : 'Private real-sample fixture is not present.'},async()=>{
  const html = await readFile(path,'utf8'), observedAt = new Date(), sourceUrl = sampleSourceUrl(html);
  const result = extractArticle(html,sourceUrl,{observedAt,timeZone:'Asia/Dhaka'});
  const publication = resolvePublication(result.dateEvidence,{observedAt,timeZone:'Asia/Dhaka'});
  assert.equal(result.status,'extracted');
  assert.ok(result.title.length > 10);
  assert.ok(result.body.length >= sample.minimumBody,'Main article body should be complete.');
  assert.ok(result.body.includes(sample.marker),'Expected article prose should be present.');
  assert.ok(!result.body.includes('প্রথম আলোর খবর পেতে গুগল নিউজ চ্যানেল ফলো করুন'));
  assert.ok(!result.body.includes('সাম্প্রতিক প্রকাশিত নিউজ সমূহ'));
  assert.equal(publicationTimestamp(publication,'published'),sample.published);
  assert.equal(publication.confidence,sample.published ? 'verified' : 'unverified');
  assert.notEqual(new URL(result.canonicalUrl).pathname,'/','An article must not adopt a homepage canonical.');
  if (!sample.published) assert.ok(result.dateEvidence.some(item=>item.source==='visible'&&item.raw==='10/08/2026'));
 });
}

test('saved browser source URL takes precedence over publisher homepage metadata',()=>{
 assert.equal(sampleSourceUrl('<!DOCTYPE html><!-- saved from url=(0036)https://news.example.com/news/story --><meta property="og:url" content="https://news.example.com/">'),'https://news.example.com/news/story');
 assert.equal(sampleSourceUrl('<meta property="og:url" content="https://news.example.com/article">'),'https://news.example.com/article');
 assert.throws(()=>sampleSourceUrl('<title>Article with unknown original URL</title>'));
});
