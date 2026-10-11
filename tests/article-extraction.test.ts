import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle } from '../packages/domain/src/article-extraction';

const url = 'https://news.example.com/news/story';
const options = {observedAt:new Date('2026-10-11T16:00:00Z'),timeZone:'Asia/Dhaka'};
const first = 'বাংলাদেশের প্রযুক্তি বাজারে রিয়েলমির নতুন ফোন এসেছে। নতুন পণ্যের বিস্তারিত তথ্য আজ আনুষ্ঠানিকভাবে প্রকাশ করা হয়েছে।';
const last = 'এই প্রতিবেদনের শেষ অনুচ্ছেদে পুরোনো ল্যাপটপ এবং অন্যান্য পণ্যের কথা রয়েছে। এখানে থাকা বাদ দেওয়ার শব্দও অবশ্যই পাওয়া যাবে।';
test('extract full main prose and title while excluding navigation, related stories and promotions', () => {
 const result = extractArticle(`<html><head><title>Publisher</title><link rel="canonical" href="/news/story?utm_source=rss"/></head><body><nav>রিয়েলমি navigation</nav><article><h1>রিয়েলমি নতুন ফোন</h1><div class="entry-content"><p>${first}</p><div class="advertisement"><p>False positive বিজ্ঞাপন</p></div><p>${last}</p><div class="related-stories"><p>Related unrelated keyword</p></div></div><aside>sidebar text</aside></article><footer>Footer</footer></body></html>`,url,options);
 assert.equal(result.status,'extracted');
 assert.equal(result.title,'রিয়েলমি নতুন ফোন');
 assert.equal(result.body,first+'\n\n'+last);
 assert.equal(result.canonicalUrl,url);
});
test('structured evidence only uses this Article publication, never modified or unrelated organization/related dates', () => {
 const result = extractArticle(`<head><script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':'Organization',datePublished:'1998-01-01'},{'@type':'NewsArticle',url,headline:'Current article',datePublished:'2026-10-11T12:00:00+06:00',dateModified:'2026-10-12T01:00:00+06:00'},{'@type':'NewsArticle',url:'https://news.example.com/other',headline:'Other article',datePublished:'2020-01-01'}]})}</script><meta property="article:published_time" content="2026-10-11T06:00:00Z"><meta property="article:modified_time" content="2026-10-12T01:00:00Z"></head><article><h1>Current article</h1><time itemprop="datePublished" datetime="2026-10-11T12:00:00+06:00">Published: 11 October 2026</time><time class="updated" datetime="2026-10-12T01:00:00Z">Updated</time><div class="article-body"><p>${first}</p><p>${last}</p></div><div class="related-stories"><time datetime="2020-01-01">2 hours ago</time></div></article>`,url,options);
 assert.equal(result.status,'extracted');
 assert.deepEqual(result.dateEvidence.filter(item=>item.source==='jsonld').map(item=>item.raw),['2026-10-11T12:00:00+06:00']);
 assert.equal(result.dateEvidence.filter(item=>item.source==='opengraph').length,1);
 assert.ok(result.dateEvidence.some(item=>item.source==='time'&&item.raw==='2026-10-11T12:00:00+06:00'));
 assert.ok(!result.dateEvidence.some(item=>item.raw==='2020-01-01'||item.raw.includes('2026-10-12')));
});
test('publisher body split across story cards remains complete while unrelated story metadata does not become dates', () => {
 const result = extractArticle(`<h1>সংবাদ শিরোনাম</h1><div class="story-metadata-wrapper"><div class="time-social-share-wrapper"><time datetime="2026-10-11T21:53:59+06:00">প্রকাশ: ১১ অক্টোবর ২০২৬, ২১: ৫৩</time><div class="social-share">Share</div></div></div><div class="story-content"><div class="storyCard"><div class="story-element-text"><p>${first}</p></div></div><div class="storyCard"><div class="story-element-text"><p>${last}</p></div></div><div><a href="https://news.google.com/publications/example">প্রথম আলোর খবর পেতে গুগল নিউজ চ্যানেল ফলো করুন</a></div></div><div class="related-stories"><div class="story-meta-data"><time>৬ ঘণ্টা আগে</time></div></div>`,url,options);
 assert.equal(result.body,first+'\n\n'+last);
 assert.ok(result.dateEvidence.some(item=>item.source==='time'&&item.raw==='2026-10-11T21:53:59+06:00'));
 assert.ok(!result.dateEvidence.some(item=>item.raw==='৬ ঘণ্টা আগে'));
});
test('div-only article paragraphs and headline-adjacent ambiguous date evidence are retained without sidebar pollution', () => {
 const result = extractArticle(`<div class="row"><div class="col-md-8"><div class="mb-4"><h1>নতুন স্মার্টফোন</h1><div class="mb-3"><a><span>10/08/2026</span></a><a>মোবাইল</a></div><p></p><div style="text-align:justify">${first}</div><div>&nbsp;</div><div style="text-align:justify">${last}</div><div class="news-post-views">Views 500</div><div class="news-detail-share-box">Share this</div></div><div class="comments">Comments</div></div><div class="sidebar"><p>${'Related false positive '.repeat(40)}</p></div></div>`,url,options);
 assert.equal(result.status,'extracted');
 assert.ok(result.body.includes(first)&&result.body.includes(last));
 assert.ok(!result.body.includes('10/08/2026')&&!result.body.includes('Views')&&!result.body.includes('Related'));
 assert.ok(!result.body.includes('মোবাইল'));
 assert.ok(result.dateEvidence.some(item=>item.source==='visible'&&item.raw==='10/08/2026'));
});
test('visible labelled Bangla/relative dates keep their observation clock, with feed evidence also preserved', () => {
 const feedEvidence = [{raw:'2026-10-11T13:00:00+06:00',source:'feed' as const,observedAt:new Date('2026-10-11T10:00:00Z')}];
 const result = extractArticle(`<article><h1>এখনকার সংবাদ</h1><div class="published-date">প্রকাশ: ২ ঘণ্টা আগে</div><div class="post-content"><p>${first}</p><p>${last}</p></div></article>`,url,{...options,feedEvidence});
 assert.ok(result.dateEvidence.some(item=>item.source==='visible'&&item.raw==='২ ঘণ্টা আগে'&&item.observedAt?.getTime()===options.observedAt.getTime()));
 assert.deepEqual(result.dateEvidence.find(item=>item.source==='feed'),feedEvidence[0]);
});
test('homepage canonical mistakes do not merge publisher articles', () => {
 const result = extractArticle(`<head><link rel="canonical" href="/"></head><article><h1>Article title</h1><p>${first}</p></article>`,url,options);
 assert.equal(result.canonicalUrl,url);
});
test('incidental CAPTCHA scripts/widgets are not blocked articles; genuine challenge and incomplete body are unresolved', () => {
 const result = extractArticle(`<title>Article title</title><script src="https://www.google.com/recaptcha/api.js"></script><article><h1>Article title</h1><div class="article-body"><p>${first}</p><p>${last}</p></div></article><div class="g-recaptcha">CAPTCHA</div>`,url,options);
 assert.equal(result.status,'extracted');
 assert.equal(extractArticle('<title>Just a moment...</title><h1>Verify you are human</h1><p>Please complete the captcha to continue to this website.</p>',url,options).status,'blocked');
 assert.equal(extractArticle('<article><h1>Article title</h1></article>',url,options).status,'extraction_failed');
 assert.equal(extractArticle(`<article><h1>Article title</h1><div class="article-body"><p>${first}</p><p>Subscribe to continue reading the rest of this article.</p></div></article>`,url,options).status,'extraction_failed');
});
test('legacy non-Unicode article text returns an encoding diagnostic instead of a readable no-match article', () => {
 const result = extractArticle(`<article><h1>Legacy news page</h1><div class="article-body"><p>${'cÖavbgš¿x †kL nvwmbv evsjv‡`k †mev '.repeat(6)}</p></div></article>`,url,options);
 assert.equal(result.status,'encoding_problem');
 assert.ok(result.reason?.includes('legacy non-Unicode'));
});
test('WordPress article headers preserve their primary title and byline publication time without site or related dates', () => {
 const result = extractArticle(`<html><body>
 <header class="site-header"><h1>Publisher site title</h1><time itemprop="datePublished" datetime="1998-01-01T00:00:00Z">Published 1 January 1998</time></header>
 <main><article class="post"><header class="entry-header"><h1>প্রযুক্তি বাজারে নতুন সংবাদ</h1>
 <div class="byline author-info"><span class="author-name">Publisher reporter</span><time itemprop="datePublished" class="published" datetime="2026-10-11T14:00:00+06:00">Published: 11 October 2026, 14:00</time><time itemprop="dateModified" class="updated" datetime="2026-10-11T18:00:00+06:00">Updated: 11 October 2026, 18:00</time></div>
 </header><div class="entry-content"><p>${first}</p><p>${last}</p></div>
 <section class="related-stories"><article><header><h1>Related title</h1><time itemprop="datePublished" datetime="2020-01-01T00:00:00Z">Published: 1 January 2020</time></header><p>Unrelated sidebar content</p></article></section></article></main>
 </body></html>`,url,options);
 assert.equal(result.status,'extracted');
 assert.equal(result.title,'প্রযুক্তি বাজারে নতুন সংবাদ');
 assert.equal(result.body,first+'\n\n'+last);
 assert.deepEqual(result.dateEvidence.filter(item=>item.source==='time').map(item=>item.raw),['2026-10-11T14:00:00+06:00']);
 assert.ok(!result.dateEvidence.some(item=>item.raw.includes('1998')||item.raw.includes('2020')||item.raw.includes('18:00')));
 assert.ok(!result.body.includes('Publisher reporter')&&!result.body.includes('Related title'));
});
test('semantic main-contained entry headers also keep publication fields',()=>{
 const result = extractArticle(`<header><h1>Site branding</h1><time datetime="2020-01-01">Site date</time></header><main><header class="entry-header"><h1>Current primary headline</h1><time itemprop="datePublished" datetime="2026-10-11T08:00:00Z">Published: 11 October 2026, 14:00</time><time itemprop="dateModified" datetime="2026-10-12T08:00:00Z">Updated</time></header><div class="entry-content"><p>${first}</p><p>${last}</p></div><aside><header><time datetime="2021-01-01">Related date</time></header></aside></main>`,url,options);
 assert.equal(result.title,'Current primary headline');
 assert.equal(result.body,first+'\n\n'+last);
 assert.deepEqual(result.dateEvidence.filter(item=>item.source==='time').map(item=>item.raw),['2026-10-11T08:00:00Z']);
});
