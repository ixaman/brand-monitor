import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { extractArticle } from '../packages/domain/src/article-extraction';
import { isCurrentPublication, publicationTimestamp, resolvePublication } from '../packages/domain/src/article-dates';

export const defaultSampleDirectory = fileURLToPath(new URL('../tests/fixtures/real-samples/',import.meta.url));

/** Browser Save Page comments contain the actual URL, unlike inaccurate publisher canonicals. */
export function sampleSourceUrl(html: string): string {
 const savedUrl = html.match(/<!--\s*saved from url=\(\d+\)(https?:\/\/\S+)\s*-->/iu)?.[1];
 const source = savedUrl || load(html)('meta[property="og:url"]').first().attr('content');
 if (!source) throw new Error('Sample has neither a browser saved-from URL nor OpenGraph URL.');
 const parsed = new URL(source);
 if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Sample source must be an HTTP(S) URL.');
 return parsed.toString();
}

export async function inspectRealSamples(directory = defaultSampleDirectory, observedAt = new Date()) {
 const entries = await readdir(directory,{withFileTypes:true});
 const samples = [];
 // Saved-page asset directories contain many iframe HTML files. Inspect only the
 // top-level article captures deliberately supplied by the operator.
 for (const entry of entries.filter(item => item.isFile() && /\.html?$/iu.test(item.name)).sort((a,b)=>a.name.localeCompare(b.name))) {
  const file = resolve(directory,entry.name), html = await readFile(file,'utf8');
  const sourceUrl = sampleSourceUrl(html);
  const extracted = extractArticle(html,sourceUrl,{observedAt,timeZone:'Asia/Dhaka'});
  const publication = resolvePublication(extracted.dateEvidence,{observedAt,timeZone:'Asia/Dhaka'});
  samples.push({file,sourceUrl,title:extracted.title,canonicalUrl:extracted.canonicalUrl,
   bodyCharacters:extracted.body.length,paragraphCount:extracted.body ? extracted.body.split('\n\n').length : 0,
   extractionStatus:extracted.status,publishedUtc:publicationTimestamp(publication,'published'),dateConfidence:publication.confidence,
   reason:extracted.reason ?? publication.reason,currentAtObservation:extracted.status==='extracted' && isCurrentPublication(publication,observedAt),
   dateEvidence:extracted.dateEvidence.map(item=>({source:item.source,raw:item.raw})),
   lastBodyExcerpt:extracted.body.slice(-160)});
 }
 return samples;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const directory = resolve(process.argv[2] ?? defaultSampleDirectory), observedAt = new Date();
 try {
  const samples = await inspectRealSamples(directory,observedAt);
  console.log(JSON.stringify({observedAt:observedAt.toISOString(),directory,status:samples.length ? 'checked' : 'skipped',
   ...(samples.length ? {} : {reason:'No top-level private article HTML fixtures are present.'}),samples},null,2));
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
   console.log(JSON.stringify({directory,status:'skipped',reason:'Private real-sample fixtures are not present.'},null,2));
  } else {
   console.error(error instanceof Error ? error.message : 'Real-sample inspection failed.');
   process.exitCode = 1;
  }
 }
}
