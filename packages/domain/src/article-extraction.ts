import { load } from 'cheerio';
import type { DateEvidence } from './article-dates';
import { detectLegacyEncoding } from './article-matching';
import { canonicalizeArticleUrl } from './article-urls';

export const EXTRACTION_VERSION = '1';
export type ArticleExtraction = {
 title: string;
 body: string;
 canonicalUrl: string;
 dateEvidence: DateEvidence[];
 status: 'extracted' | 'encoding_problem' | 'extraction_failed' | 'blocked';
 reason: string | null;
};
export type ArticleExtractionOptions = { observedAt: Date; timeZone: string; feedEvidence?: DateEvidence[] };
type StructuredArticle = Record<string, unknown>;
const publicationLabel = /(?:\bpublished(?:\s+on|\s+at)?\b|\bpublication(?:\s+date)?\b|প্রকাশ(?:িত)?(?:\s*[:：]|\s*(?:সময়|সময়|তারিখ)))/iu;
const modifiedLabel = /(?:\bmodified\b|\bupdated\b|dateModified|হালনাগাদ|আপডেট|সর্বশেষ\s+আপডেট)/iu;
const noiseClass = /(?:^|[-_\s])(?:related|recommended|recommendations|suggested|sidebar|comments?|social|share|sharing|advertisement|ads?|adslot|promo|cookie|newsletter|navigation|menu|footer|caption|author|byline|tags?|breadcrumb)(?:[-_\s]|$)/i;
const bodySelector = '[itemprop="articleBody"], .entry-content, .post-content, .post-body, .article-content, .article-body, .news-content, .content-details, .details-content, .details-brief, .story-content';
const cleanSpace = (value: string) => value.replace(/[\t\r\n\u00a0 ]+/gu, ' ').trim();

function articleNodes(value: unknown, output: StructuredArticle[], depth = 0): void {
 if (depth > 12 || output.length > 100) return;
 if (Array.isArray(value)) { for (const child of value.slice(0,100)) articleNodes(child, output, depth+1); return; }
 if (!value || typeof value !== 'object') return;
 const node = value as StructuredArticle;
 const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
 if (types.some(type => typeof type === 'string' && /(?:^|\/)(?:NewsArticle|Article|BlogPosting|ReportageNewsArticle)$/i.test(type))) output.push(node);
 // Traverse graph/mainEntity only. Embedded recommendation/itemList articles do not
 // become the current article's publication evidence.
 if (node['@graph']) articleNodes(node['@graph'], output, depth+1);
 if (node.mainEntity) articleNodes(node.mainEntity, output, depth+1);
}

function structuredIdentity(node: StructuredArticle): string | null {
 if (typeof node.url === 'string') return node.url;
 if (typeof node.mainEntityOfPage === 'string') return node.mainEntityOfPage;
 if (node.mainEntityOfPage && typeof node.mainEntityOfPage === 'object') {
  const id = (node.mainEntityOfPage as StructuredArticle)['@id']; if (typeof id === 'string') return id;
 }
 return null;
}

/** Anonymous article extraction; all dates remain raw evidence for the domain parser. */
export function extractArticle(html: string, url: string, options?: ArticleExtractionOptions): ArticleExtraction {
 const $ = load(html);
 const observedAt = options?.observedAt ?? new Date();
 const canonicalHref = $('link[rel]').filter((_i, element) => /(?:^|\s)canonical(?:\s|$)/i.test($(element).attr('rel') ?? '')).first().attr('href');
 const canonicalUrl = canonicalizeArticleUrl(url, undefined, canonicalHref);
 const dateEvidence: DateEvidence[] = [...(options?.feedEvidence ?? [])];
 const evidence = (raw: string | undefined, source: DateEvidence['source']) => {
  if (raw?.trim() && !dateEvidence.some(item => item.raw === raw.trim() && item.source === source)) dateEvidence.push({raw:raw.trim(),source,observedAt});
 };
 const allNodes: StructuredArticle[] = [];
 $('script[type="application/ld+json"]').slice(0,30).each((_i, element) => {
  try { articleNodes(JSON.parse($(element).text()), allNodes); } catch { /* malformed JSON-LD is not trusted evidence */ }
 });
 const headline = cleanSpace($('h1').filter((_i, element) => {
  const el = $(element);
  if (el.closest('nav, footer, aside, [hidden]').length) return false;
  // Semantic article headers commonly contain the title and publication time.
  // Only a site-level navigation header is excluded from headline selection.
  return !el.closest('header').length || el.closest('article, main').length > 0;
 }).first().text());
 const nodes = allNodes.filter(node => {
  const identity = structuredIdentity(node);
  if (identity) { try { return canonicalizeArticleUrl(identity,url) === canonicalUrl; } catch { return false; } }
  const title = typeof node.headline === 'string' ? cleanSpace(node.headline) : '';
  return !headline || !title || title === headline;
 });
 for (const node of nodes) if (typeof node.datePublished === 'string') evidence(node.datePublished, 'jsonld');
 $('meta').each((_i, element) => {
  const key = ($(element).attr('property') || $(element).attr('name') || '').toLowerCase();
  if (['article:published_time','og:published_time','publication_date','pubdate','publishdate','datepublished'].includes(key)) evidence($(element).attr('content'), 'opengraph');
 });
 const title = headline || cleanSpace($('meta[property="og:title"]').attr('content') || '') ||
  cleanSpace(typeof nodes[0]?.headline === 'string' ? nodes[0].headline : '') || cleanSpace($('title').text());

 // Strip UI and recommendation sections before selecting the article's body and dates.
 $('script, style, noscript, nav, footer, aside, form, button, iframe, svg, canvas, [hidden], [aria-hidden="true"]').remove();
 $('header').filter((_i, element) => !$(element).closest('article, main').length).remove();
 $('[class], [id], [role]').each((_i, element) => {
  const el = $(element), role = el.attr('role');
  const metadata = `${el.attr('class') ?? ''} ${el.attr('id') ?? ''}`;
  // Publishers place publication fields beside author or sharing controls. Keep
  // their date-bearing wrapper until evidence collection; the body clone removes
  // those metadata wrappers. Recommendation/sidebar wrappers are still removed.
  const hasDateInMetadataWrapper = /(?:^|[-_\s])(?:social|share|sharing|author|byline)(?:[-_\s]|$)/i.test(metadata) && el.find('time, [itemprop="datePublished"]').length > 0;
  if (['navigation','complementary','contentinfo'].includes(role ?? '') || (noiseClass.test(metadata) && !hasDateInMetadataWrapper)) el.remove();
 });
 const heading = $('h1').first();
 // Body candidates include semantic article containers and heading ancestors. The
 // latter covers small portals that put Word-exported <div> paragraphs beside h1.
 const candidates = new Set([...$(bodySelector).toArray(), ...$('article, main').toArray(), ...heading.parents().slice(0,8).toArray()]);
 let body = '', bestScore = -Infinity;
 let chosen = heading.parent();
 for (const element of candidates) {
  const candidate = $(element).clone();
  candidate.find('h1').nextAll().slice(0,3).each((_i, child) => {
   const adjacent = $(child), text = cleanSpace(adjacent.text());
   if (text.length < 180 && (adjacent.find('time').length || adjacent.find('span, a').toArray().some(part => /^[০-৯\d]{1,2}[\/.\-][০-৯\d]{1,2}[\/.\-][০-৯\d]{4}$/u.test(cleanSpace($(part).text()))))) adjacent.remove();
  });
  candidate.find('h1, time, [itemprop="datePublished"], [itemprop="dateModified"]').remove();
  candidate.find('[class], [id]').each((_i, child) => {
   const meta = `${$(child).attr('class') ?? ''} ${$(child).attr('id') ?? ''}`;
   if (/(?:^|[-_\s])(?:metadata|meta|pub-up|post-date|published|updated|news-post-views|author|byline|social|share|sharing)(?:[-_\s]|$)/i.test(meta)) $(child).remove();
  });
  // Remove short metadata directly after the headline, including unlabelled dates.
  candidate.find('a, span, div, p').each((_i, child) => {
   const text = cleanSpace($(child).text());
   const subscriptionCallout = /(?:খবর|নিউজ).*পেতে.*(?:ফলো|অনুসরণ) করুন/u.test(text) || /follow (?:us|our|the).*(?:google news|channel)/i.test(text);
   if (text.length < 180 && (subscriptionCallout || (publicationLabel.test(text) || modifiedLabel.test(text)) || /^[০-৯\d]{1,2}[\/.\-][০-৯\d]{1,2}[\/.\-][০-৯\d]{4}$/u.test(text))) $(child).remove();
  });
  candidate.find('br').replaceWith('\n');
  candidate.find('p, div, section, h2, h3, h4, li, blockquote').prepend('\n').append('\n');
  const text = candidate.text().split('\n').map(cleanSpace).filter(Boolean).join('\n\n');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const linkText = candidate.find('a').toArray().reduce((total,anchor) => total + cleanSpace($(anchor).text()).length,0);
  const linkRatio = linkText / Math.max(text.length,1);
  if (letters < 50 || linkRatio > .45) continue;
  const semantic = $(element).is(bodySelector) ? 2 : $(element).is('article') ? 1.25 : 1;
  // Prefer the compact prose container over a page that embeds many story cards.
  const proseRatio = letters / Math.max(cleanSpace($(element).text()).length,1);
  const score = letters * semantic * Math.max(.2,proseRatio) * (1-linkRatio*2);
  if (score > bestScore) { bestScore = score; body = text; chosen = $(element); }
 }
 // Use a metadata scope containing both the primary heading and body. Avoid times
 // in other story cards even when publishers use multiple <time> elements.
 let dateScope = chosen;
 if (heading.length && !chosen.find('h1').length) {
  const common = heading.parents().toArray().find(element => $(element).find(chosen).length);
  if (common) dateScope = $(common);
 }
 dateScope.find('time, [itemprop="datePublished"]').each((_i, element) => {
  const el = $(element), ownText = cleanSpace(el.text()), nearby = cleanSpace(el.parent().text()).slice(0,300);
  if (el.attr('itemprop') === 'dateModified' || modifiedLabel.test(`${el.attr('class') ?? ''} ${ownText}`)) return;
  if (el.closest('.story-meta-data, .story-card, .storyCard, .related').length) return;
  if (modifiedLabel.test(nearby) && !publicationLabel.test(ownText) && el.attr('itemprop') !== 'datePublished') return;
  evidence(el.attr('datetime') || el.attr('content') || ownText,'time');
 });
 dateScope.find('span, div, p, time').each((_i, element) => {
  const el = $(element), text = cleanSpace(el.text());
  if (text.length > 220 || !publicationLabel.test(text) || modifiedLabel.test(text)) return;
  if (el.find('span, div, p, time').toArray().some(child => publicationLabel.test(cleanSpace($(child).text())) && /[০-৯\d]/u.test($(child).text()))) return;
  evidence(text.replace(publicationLabel,'').replace(/^\s*[:：]\s*/u,'').trim(),'visible');
 });
 // Short headline-adjacent date metadata is preserved as untrusted visible evidence.
 // Ambiguous numeric formats must be rejected by the date parser, not guessed here.
 heading.nextAll().slice(0,3).find('span, a, time').add(heading.nextAll().slice(0,3)).each((_i, element) => {
  const raw = cleanSpace($(element).text());
  if (/^[০-৯\d]{1,2}[\/.\-][০-৯\d]{1,2}[\/.\-][০-৯\d]{4}$/u.test(raw)) evidence(raw,'visible');
 });
 const output = {title,body,canonicalUrl,dateEvidence};
 const visibleText = cleanSpace($('body').text());
 const challengeTitle = /^(?:just a moment|access denied|attention required|sorry,? you have been blocked|verify (?:you are|that you are) human|checking your browser)/i.test(title);
 const challengeText = /(?:verify (?:you are|that you are) human|checking your browser|unusual traffic|access denied|complete (?:the )?captcha)/i.test(visibleText.slice(0,3000));
 if (challengeTitle || ((!body || body.length < 300) && !nodes.length && !$(bodySelector).length && challengeText))
  return {...output,status:'blocked',reason:'Publisher returned a browser verification or access-block page.'};
 if (!title || !body) return {...output,status:'extraction_failed',reason:'A complete article title and readable main body could not be extracted.'};
 if (/(?:subscribe to (?:continue|read)|subscription required|sign in to (?:continue|read)|এই প্রতিবেদনটি পড়তে সাবস্ক্রাইব)/i.test(body))
  return {...output,status:'extraction_failed',reason:'Article body is incomplete behind a subscription or sign-in prompt.'};
 if (detectLegacyEncoding(title,body)) return {...output,status:'encoding_problem',reason:'Article text appears to use legacy non-Unicode Bangla encoding.'};
 return {...output,status:'extracted',reason:null};
}
