import { currentUser } from '../lib/current-user';
import { SignIn, SignOut } from './sign-in';
export const dynamic = 'force-dynamic';
export default async function Home() {
 const user = await currentUser();
 return <main><h1>Brand monitoring</h1>{user ? <><p>Signed in as {user.email} · {user.role}</p><p>Workspace ready. Monitoring will be added in later slices.</p><SignOut /></> : <><p>Access is limited to approved team members.</p><SignIn /></>}</main>;
}
