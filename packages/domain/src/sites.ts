import { parse } from 'csv-parse/sync';
import ipaddr from 'ipaddr.js';
import { ValidationError } from './keywords';
export const MAX_IMPORT_BYTES = 512 * 1024;
export const MAX_IMPORT_LINES = 1000;
export type SiteInput = { name: string; url: string; listing_url: string | null };
export type ImportRow = { line: number; input: string; site?: SiteInput; error?: string };
export function isPublicAddress(address: string) {
 try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function normalizeSiteUrl(raw: string, base?: string, preserveTrailingSlash = false): string {
 const value = raw.trim();
 if (!value || value.length > 2048 || /[\s\\\u0000-\u001F]/u.test(value)) throw new ValidationError('URL is empty, too long, or contains spaces/control characters.');
 let url: URL;
 try {
  url = base ? new URL(value, base) : new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
 } catch { throw new ValidationError('Invalid URL.'); }
 if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new ValidationError('Use a public HTTP(S) URL without credentials.');
 if (url.port && !['80','443'].includes(url.port)) throw new ValidationError('Only standard HTTP(S) ports are supported.');
 const host = url.hostname.toLowerCase().replace(/\.$/, '');
 const bare = host.replace(/^\[|\]$/g, '');
 if (ipaddr.isValid(bare) ? !isPublicAddress(bare) : (!host.includes('.') || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(host)))
  throw new ValidationError('URL must use a public host.');
 url.hostname = host;
 url.hash = '';
 for (const key of [...url.searchParams.keys()]) if (/^(utm_.*|fbclid|gclid|dclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
 url.searchParams.sort();
 if (!preserveTrailingSlash) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
 return preserveTrailingSlash ? url.toString() : url.toString().replace(/\/(?=\?|$)/, '');
}
export function siteInput(name: string, url: string, listing = ''): SiteInput {
 const normalized = normalizeSiteUrl(url);
 const cleanName = name.trim().normalize('NFC');
 if (cleanName.length > 200) throw new ValidationError('Name must be at most 200 characters.');
 return { name: cleanName || new URL(normalized).hostname, url: normalized, listing_url: listing.trim() ? normalizeSiteUrl(listing, /^(?:\/|\.\.?\/)/.test(listing.trim()) ? normalized + '/' : undefined) : null };
}
export function parseSiteImport(text: string, mode: 'paste' | 'csv'): ImportRow[] {
 if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new ValidationError('Import is limited to 512 KiB.');
 const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
 if (lines.filter(line => line.trim()).length > MAX_IMPORT_LINES + (mode === 'csv' ? 1 : 0)) throw new ValidationError('Import is limited to 1000 lines.');
 const results: ImportRow[] = [];
 let columns: string[] | undefined;
 let headerError: string | undefined;
 for (let i = 0; i < lines.length; i++) {
  const input = lines[i].trim();
  if (!input) continue;
  try {
   // Parse records separately so a malformed quoted line cannot swallow later rows.
   const fields = (parse(input, { trim: true, relax_column_count: true }) as string[][])[0];
   if (mode === 'csv' && !columns) {
    columns = fields.map(field => field.toLowerCase());
    if (!columns.includes('url') || new Set(columns).size !== columns.length || columns.some(column => !['name','url','listing_url'].includes(column))) {
     headerError = 'CSV header must contain url, with optional name and listing_url.';
     results.push({line:i+1,input,error:headerError});
    }
    continue;
   }
   if (headerError) throw new ValidationError(headerError);
   let name = '', url = '', listing = '';
   if (mode === 'paste') {
    if (fields.length === 1) [url] = fields;
    else if (fields.length === 2) [name,url] = fields;
    else throw new ValidationError('Use URL or name, URL (two columns).');
   } else {
    if (fields.length !== columns!.length) throw new ValidationError('CSV column count does not match its header.');
    name = fields[columns!.indexOf('name')] ?? '';
    url = fields[columns!.indexOf('url')] ?? '';
    listing = fields[columns!.indexOf('listing_url')] ?? '';
   }
   results.push({line:i+1,input,site:siteInput(name,url,listing)});
  } catch (error) {
   results.push({line:i+1,input,error:error instanceof ValidationError ? error.message : 'Malformed CSV quoting; each record must fit on one line.'});
  }
 }
 return results;
}
export function validateTimezone(zone: string) {
 try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { throw new ValidationError('Invalid source timezone.'); }
 return zone;
}
