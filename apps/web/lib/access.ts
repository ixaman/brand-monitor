import type { Pool } from 'pg';
export type Role = 'admin' | 'analyst' | 'viewer';
export function canManage(role: Role) { return role === 'admin' || role === 'analyst'; }
export async function approvedUser(pool: Pool, email: string, verified: boolean) {
 if (!verified) return null;
 const result = await pool.query<{ id: string; email: string; role: Role }>(
  "SELECT id, email, role FROM monitor.app_users WHERE email = $1 AND state = 'active'", [email.trim().toLowerCase()]);
 return result.rows[0] ?? null;
}
