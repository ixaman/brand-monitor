'use client';
import { createAuthClient } from 'better-auth/react';
const client = createAuthClient();
export function SignIn() { return <button onClick={() => client.signIn.social({ provider: 'google', callbackURL: '/' })}>Sign in with Google</button>; }
export function SignOut() { return <button onClick={async () => { await client.signOut(); window.location.reload(); }}>Sign out</button>; }
