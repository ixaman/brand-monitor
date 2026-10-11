import Link from 'next/link';
import { currentUser } from '../lib/current-user';
import { SignIn, SignOut } from './sign-in';
export const dynamic = 'force-dynamic';
export default async function Home() {
 const user = await currentUser();
 return <main><h1>Brand monitoring</h1>{user ? <><p>Signed in as {user.email} · {user.role}</p><p><Link href="/mentions">Mentions dashboard</Link></p><p><Link href="/clients">Manage clients and keywords</Link></p><p><Link href="/sites">Manage watched sites</Link></p><SignOut /></> : <><p>Access is limited to approved team members.</p><SignIn /></>}</main>;
}
