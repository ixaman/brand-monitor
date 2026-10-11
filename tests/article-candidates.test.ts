import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isArticleCandidateUrl, sortArticleDiscoveries } from '../packages/domain/src/article-candidates';
import type { ArticleDiscovery } from '../packages/domain/src/article-collection';

const base='https://news.example.com';
test('article queue excludes navigation, archives, print, search and other publishers',()=> {
 for(const path of ['/', '/index.html', '/index.php', '/home.aspx', '/news', '/latest', '/bangladesh', '/category/bangladesh', '/category/deeper', '/category/section-0', '/tag/brand', '/archive/2026', '/archive.php', '/2026/10/12', '/print/123', '/print.php?id=123', '/story?print=1', '/story?output=1', '/search/brand', '/?s=Brand', '/page/2', '/story?page=2', '/story?pageno=2', '/story?offset=20', '/sitemap.xml', '/contact', '/sports'])
  assert.equal(isArticleCandidateUrl(path,base),false,path);
 for(const path of ['/story', '/story-0', '/story/amp/?utm_source=feed', '/amp/story', '/bangladesh/new-story', '/news/12345', '/2026/10/12/new-story', '/?p=123', '/index.php?p=123'])
  assert.equal(isArticleCandidateUrl(path,base),true,path);
 assert.equal(isArticleCandidateUrl('https://other.example.com/story-1',base),false);
 assert.equal(isArticleCandidateUrl('https://m.news.example.com/story-1',base),true);
 assert.equal(isArticleCandidateUrl('https://m.news.example.com/story-1',base,{listing:true}),false);
 assert.equal(isArticleCandidateUrl('https://www.news.example.com/story-1',base,{listing:true}),true);
 assert.equal(isArticleCandidateUrl('/unrelated',base,{listing:true}),false);
 assert.equal(isArticleCandidateUrl('/story-0',base,{listing:true}),true);
 assert.equal(isArticleCandidateUrl('/bangladesh/story',base,{listing:true}),true);
 assert.equal(isArticleCandidateUrl('/story-0/amp',base,{listing:true}),true);
 assert.equal(isArticleCandidateUrl('/amp/story-0',base,{listing:true}),true);
 for(const path of ['/amp','/category/deeper/amp','/amp/search.php?keyword=x'])
  assert.equal(isArticleCandidateUrl(path,base),false,path);
 const localizedBase=`${base}/en`;
 for(const url of ['/en','/en/','https://www.news.example.com/en?utm_source=feed'])
  assert.equal(isArticleCandidateUrl(url,localizedBase),false,url);
 assert.equal(isArticleCandidateUrl('/en/new-story',localizedBase,{listing:true}),true);
 for(const url of ['/news/print.php?id=123','/news/search.php?keyword=x','/news/print.html?id=123','/news/search.aspx?keyword=x'])
  assert.equal(isArticleCandidateUrl(url,base),false,url);
});

test('candidate priority uses publication microseconds, then newest discovery, preserving ties',()=> {
 const discovery=(id:string,published:string|null,discovered:string):ArticleDiscovery=>({
  url:`${base}/${id}`,source:'rss',discoveredAt:new Date(discovered),
  dateEvidence:published?[{raw:published,source:'feed'}]:[],
 });
 const result=sortArticleDiscoveries([
  discovery('no-date-old',null,'2026-10-12T01:00:00Z'),
  discovery('old-publication','2026-10-11T23:00:00Z','2026-10-12T03:00:00Z'),
  discovery('precise-earlier','2026-10-12T00:00:00.000001Z','2026-10-12T03:00:00Z'),
  discovery('tie-older','2026-10-12T00:00:00.000002Z','2026-10-12T02:00:00Z'),
  discovery('no-date-new',null,'2026-10-12T03:00:00Z'),
  discovery('tie-newer','2026-10-12T00:00:00.000002Z','2026-10-12T03:00:00Z'),
 ]);
 assert.deepEqual(result.map(item=>new URL(item.url).pathname),[
  '/tie-newer','/tie-older','/precise-earlier','/old-publication','/no-date-new','/no-date-old',
 ]);
});
