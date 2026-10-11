import 'server-only';
import { headers } from 'next/headers';
import { auth } from './auth';
import { db } from './db';
import { approvedUser } from './access';
export async function currentUser() {
 const session = await auth.api.getSession({ headers: await headers() });
 return session ? approvedUser(db, session.user.email, session.user.emailVerified) : null;
}
