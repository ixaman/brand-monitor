import { currentUser } from '../../../lib/current-user';
export async function GET() {
 const user = await currentUser();
 return user ? Response.json(user) : Response.json({ error: 'Unauthorized' }, { status: 401 });
}
