import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeArticleUrl } from '../packages/domain/src/article-urls';

test('article canonicalization strips tracking, fragment/default port/trailing slash while preserving content identity', () => {
 assert.equal(canonicalizeArticleUrl('https://WWW.News.example.com:443/News/Story/?id=42&utm_source=feed&fbclid=x&gclid=y#comments'), 'https://news.example.com/News/Story?id=42');
 assert.equal(canonicalizeArticleUrl('http://news.example.com:80/story?articleId=123&edition=bn'), 'http://news.example.com/story?articleId=123&edition=bn');
 assert.notEqual(canonicalizeArticleUrl('https://news.example.com/News/Story?id=42'),canonicalizeArticleUrl('https://news.example.com/news/story?id=42'));
 assert.notEqual(canonicalizeArticleUrl('https://news.example.com/story?id=42'),canonicalizeArticleUrl('https://news.example.com/story?id=43'));
});
test('conventional AMP/mobile representations share article identity', () => {
 const expected = 'https://news.example.com/Story?id=7';
 for (const raw of ['https://amp.news.example.com/Story/amp?id=7','https://m.news.example.com/amp/Story?id=7&output=amp','https://mobile.news.example.com/Story?id=7&amp=1','https://www.news.example.com/Story?id=7&mobile=true']) assert.equal(canonicalizeArticleUrl(raw),expected);
 assert.equal(canonicalizeArticleUrl('https://news.example.com/story?amp=chapter&mobile=author'), 'https://news.example.com/story?amp=chapter&mobile=author');
 assert.equal(canonicalizeArticleUrl('https://news.example.com/amp'), 'https://news.example.com/amp');
});
test('honor trusted relative canonical while rejecting unsafe unrelated domain/homepage claims', () => {
 const raw = 'https://m.news.example.com/mobile/story?utm_source=rss';
 assert.equal(canonicalizeArticleUrl(raw,undefined,'../canonical-story?id=81&utm_medium=social#read'),'https://news.example.com/canonical-story?id=81');
 assert.equal(canonicalizeArticleUrl(raw,undefined,'https://www.news.example.com/canonical-story'),'https://news.example.com/canonical-story');
 for (const claim of ['https://attacker.example.com/story','http://127.0.0.1/private','https://news.example.com/','javascript:alert(1)','https://user:password@news.example.com/story']) assert.equal(canonicalizeArticleUrl(raw,undefined,claim),'https://news.example.com/mobile/story');
 assert.equal(canonicalizeArticleUrl(raw,undefined,'https://other.news.example.com/story'),'https://news.example.com/mobile/story');
});
test('reject credentials, unsupported protocols, private destinations and oversized identities', () => {
 for (const raw of ['https://user:pass@news.example.com/story','file:///etc/passwd','http://127.0.0.1/news','http://192.168.1.1/story','http://localhost/story','https://news.example.com/'+ 'x'.repeat(2048)]) assert.throws(()=>canonicalizeArticleUrl(raw));
});
