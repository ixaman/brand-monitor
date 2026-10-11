'use server';
import { currentUser } from '../../lib/current-user';
import { db } from '../../lib/db';
import { reviewMentions } from '../../lib/mentions';
import { AccessError, NotFoundError, ValidationError } from '../../lib/clients';
import { revalidatePath } from 'next/cache';
export async function review(form: FormData): Promise<{error?:string}> {
 try {
  const user=await currentUser();
  if (!user) throw new AccessError('Sign in with an approved account.');
  await reviewMentions(db,user.id,String(form.get('client')),form.getAll('ids').map(String),String(form.get('status')));
  revalidatePath('/mentions');return {};
 } catch(error) {
  if (error instanceof AccessError || error instanceof ValidationError || error instanceof NotFoundError) return {error:error.message};
  throw error;
 }
}
