'use server';
import { revalidatePath } from 'next/cache';
import { currentUser } from '../../lib/current-user';
import { db } from '../../lib/db';
import { addSite, importSites, requestDetection, configureSite, authorizeSites, SiteAccessError, SiteNotFoundError, ValidationError, type ImportResult } from '../../../../packages/domain/src/site-store';
import { MAX_IMPORT_BYTES } from '../../../../packages/domain/src/sites';
export type SiteActionState = { results: ImportResult[]; message: string };
const text = (form: FormData, key: string) => String(form.get(key) ?? '');
const lines = (form: FormData, key: string) => text(form,key).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export async function siteAction(_previous: SiteActionState, form: FormData): Promise<SiteActionState> {
 try {
  const user = await currentUser();
  if (!user) throw new SiteAccessError('Sign in with an approved account.');
  await authorizeSites(db,user.id,true);
  const action = text(form,'action');
  const id = text(form,'id');
  let results: ImportResult[] = [];
  let message = '';
  if (action === 'add') results = await addSite(db,user.id,text(form,'name'),text(form,'url'));
  else if (action === 'paste') results = await importSites(db,user.id,text(form,'sites'),'paste');
  else if (action === 'csv') {
   const file = form.get('file');
   if (!(file instanceof File) || !file.size) throw new ValidationError('Choose a CSV file.');
   if (file.size > MAX_IMPORT_BYTES) throw new ValidationError('CSV upload is limited to 512 KiB.');
   results = await importSites(db,user.id,await file.text(),'csv');
  } else if (action === 'detect' || action === 'configure') {
   if (action === 'detect') await requestDetection(db,user.id,id);
   else await configureSite(db,user.id,id,{name:text(form,'name'),source_timezone:text(form,'source_timezone'),scan_depth:Number(text(form,'scan_depth')),active:form.get('active')==='on',listing_url:text(form,'listing_url'),feeds:lines(form,'feeds'),sitemaps:lines(form,'sitemaps'),listings:lines(form,'listings')});
   message = 'Detection queued. Keep the worker running; this page updates automatically.';
  } else throw new ValidationError('Invalid action.');
  if (['add','paste','csv'].includes(action)) {
   message = results.length ? `${results.filter(row => row.status==='Added').length} added, ${results.filter(row => row.status==='Skipped (duplicate)').length} duplicates skipped, ${results.filter(row => row.status==='Invalid').length} invalid.` : 'No sites to import.';
  }
  revalidatePath('/sites');
  return {results,message};
 } catch (error) {
  if (!(error instanceof SiteAccessError || error instanceof SiteNotFoundError || error instanceof ValidationError)) throw error;
  return {results:[],message:error.message};
 }
}
