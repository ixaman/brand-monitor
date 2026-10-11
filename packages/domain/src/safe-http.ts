import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, normalizeSiteUrl } from './sites';
export type RawPage = { url: string; body: string; contentType: string };
export type PageFetcher = (url: string, signal: AbortSignal) => Promise<RawPage>;
export type ResolveHost = (host: string) => Promise<{ address: string; family: number }[]>;
export async function publicDestination(raw: string, resolve: ResolveHost = host => lookup(host, { all: true })) {
 const url = new URL(normalizeSiteUrl(raw,undefined,true));
 const host = url.hostname.replace(/^\[|\]$/g, '');
 const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await resolve(host);
 if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Unsafe DNS destination.');
 return {url, address:addresses[0]};
}
const MAX_BYTES = 1024 * 1024;
export function checkBodySize(bytes: number) {
 if (bytes > MAX_BYTES) throw new Error('Response exceeds 1 MiB.');
}
export function redirectTarget(from: string, location: string, hops: number) {
 if (hops >= 3) throw new Error('Redirect limit exceeded.');
 return normalizeSiteUrl(location, from,true);
}
export function createSafeFetcher(options: { timeoutMs?: number; beforeRequest?: (url: string, signal: AbortSignal) => Promise<() => Promise<void>> } = {}): PageFetcher {
 return async (raw, outerSignal) => {
 const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(options.timeoutMs ?? 4000)]);
 let target = raw;
 for (let hops = 0; ; hops++) {
  signal.throwIfAborted();
  // Resolution is raced against the same deadline; the validated address is pinned to the socket.
  const {url,address} = await new Promise<Awaited<ReturnType<typeof publicDestination>>>((resolve, reject) => {
   const aborted = () => reject(signal.reason);
   signal.addEventListener('abort', aborted, {once:true});
   publicDestination(target).then(resolve,reject).finally(() => signal.removeEventListener('abort',aborted));
  });
  signal.throwIfAborted();
  const release = await options.beforeRequest?.(url.toString(), signal);
  let response;
  try { response = await new Promise<{ status: number; location?: string; body: string; contentType: string }>((resolve, reject) => {
   const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    signal, agent:false, headers:{ 'User-Agent':'BrandMonitor/0.3 (public news monitoring)', Accept:'text/html, application/xml, text/xml, application/rss+xml, application/atom+xml', 'Accept-Encoding':'identity' },
    // Do not let DNS be resolved again between validation and connection.
    lookup: (_host, options, callback) => {
     if (options.all) callback(null, [address]);
     else callback(null, address.address, address.family);
    }
   }, incoming => {
    const status = incoming.statusCode ?? 0;
    const location = incoming.headers.location;
    if ([301,302,303,307,308].includes(status) && location) { incoming.destroy(); resolve({status,location,body:'',contentType:''}); return; }
    if (status < 200 || status >= 300) { incoming.destroy(); reject(new Error(`HTTP ${status}`)); return; }
    if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') { incoming.destroy(); reject(new Error('Unsupported compressed response.')); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    incoming.on('data', (chunk: Buffer) => {
     bytes += chunk.length;
     try { checkBodySize(bytes); } catch (error) { incoming.destroy(); reject(error); return; }
     chunks.push(chunk);
    });
    incoming.on('error',reject);
    incoming.on('end', () => resolve({status,body:Buffer.concat(chunks).toString('utf8'),contentType:incoming.headers['content-type'] ?? ''}));
   });
   request.on('error',reject); request.end();
  }); } finally { await release?.(); }
  if (response.location) { target = redirectTarget(url.toString(),response.location,hops); continue; }
  return {url:url.toString(),body:response.body,contentType:response.contentType};
 }
};
}
export const safeFetchPage = createSafeFetcher();
