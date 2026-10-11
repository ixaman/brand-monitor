'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentUser } from '../../lib/current-user';
import { db } from '../../lib/db';
import { mutateClient, mutateKeyword, AccessError, NotFoundError, ValidationError } from '../../lib/clients';
const text = (form: FormData, key: string) => String(form.get(key) ?? '');
const lines = (form: FormData, key: string) => text(form, key).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
export async function save(form: FormData) {
 let destination = '/clients';
 try {
  const user = await currentUser();
  if (!user) throw new AccessError('Sign in with an approved account.');
  const action = text(form, 'action');
  if (action !== 'create' && action !== 'update' && action !== 'delete') throw new ValidationError('Invalid action.');
  const id = text(form, 'id');
  const active = form.get('active') === 'on';
  if (text(form, 'entity') === 'client') {
   const clientId = await mutateClient(db, user.id, action, id, { name: text(form,'name'), notes: text(form,'notes'), active });
   if (action !== 'delete') destination += `?client=${clientId}`;
  } else if (text(form, 'entity') === 'keyword') {
   const clientId = text(form,'client_id');
   const raw = text(form,'boolean_ast').trim();
   let ast: unknown = null;
   if (action !== 'delete' && raw) {
    try { ast = JSON.parse(raw); } catch { throw new ValidationError('Boolean expression must be valid JSON.'); }
   }
   await mutateKeyword(db,user.id,clientId,action,id,{ term: text(form,'term'), aliases: lines(form,'aliases'), exclusions: lines(form,'exclusions'), match_type: text(form,'match_type'), boolean_ast: ast, active });
   destination += `?client=${encodeURIComponent(clientId)}`;
  } else throw new ValidationError('Invalid entity.');
  revalidatePath('/clients');
 } catch (error) {
  if (!(error instanceof ValidationError || error instanceof AccessError || error instanceof NotFoundError)) throw error;
  destination = `/clients?error=${encodeURIComponent(error.message)}`;
 }
 redirect(destination);
}
