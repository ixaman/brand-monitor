import { Pool } from 'pg';
const [email, role, state] = process.argv.slice(2);
if (!email || !['admin','analyst','viewer'].includes(role) || !['invited','active','disabled'].includes(state)) throw new Error('Usage: pnpm users:set EMAIL admin|analyst|viewer invited|active|disabled');
const db = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
 await db.query('BEGIN');
 await db.query(`INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES(lower(trim($1)),$2,$3,CASE WHEN $3 = 'active' THEN now() END)
 ON CONFLICT(email) DO UPDATE SET role=$2,state=$3,approved_at=CASE WHEN $3='active' THEN now() ELSE NULL END,updated_at=now()`, [email, role, state]);
 if (state !== 'active') await db.query('DELETE FROM monitor.session WHERE "userId" IN (SELECT id FROM monitor."user" WHERE lower(email)=lower(trim($1)))', [email]);
 await db.query('COMMIT'); console.log('User access updated');
} catch (error) { await db.query('ROLLBACK'); throw error; } finally { await db.end(); }
