import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { db } from './db';
import { approvedUser } from './access';
export const auth = betterAuth({
 database: db,
 baseURL: process.env.BETTER_AUTH_URL,
 secret: process.env.BETTER_AUTH_SECRET,
 socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } },
 account: { accountLinking: { enabled: false }, storeAccountCookie: false },
 session: { cookieCache: { enabled: false }, expiresIn: 60 * 60 * 24 },
 advanced: { useSecureCookies: process.env.BETTER_AUTH_URL?.startsWith('https://'), defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
 databaseHooks: {
  user: { create: { before: async (user) => {
   if (!await approvedUser(db, user.email, user.emailVerified)) throw new APIError('FORBIDDEN', { message: 'An administrator must approve your verified Google email.' });
  } } },
  session: { create: { before: async (session) => {
   const { rows } = await db.query('SELECT email, "emailVerified" FROM monitor."user" WHERE id = $1', [session.userId]);
   if (!rows[0] || !await approvedUser(db, rows[0].email, rows[0].emailVerified)) throw new APIError('FORBIDDEN', { message: 'Access is not approved.' });
  } } },
  account: {
   create: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) },
   update: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) }
  }
 }
});
