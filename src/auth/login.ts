import bcrypt from 'bcrypt';
import { getSystemDb } from '../db/router.js';
import { signToken } from './jwt.js';

interface UserDoc {
  userId: string;
  email: string;
  role: 'admin' | 'debt-counselor' | 'engineer' | 'client-viewer';
  clientId?: string;
  passwordHash: string;
  status: string;
}

export async function login(email: string, password: string): Promise<{ token: string; expiresIn: number } | null> {
  const user = await getSystemDb().collection<UserDoc>('users').findOne({ email, status: 'active' });
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  const tenantBound = user.role === 'debt-counselor' || user.role === 'client-viewer';
  const crossTenant = user.role === 'admin' || user.role === 'engineer';

  const { token, expiresIn } = signToken({
    userId: user.userId,
    role: user.role,
    tenantId: tenantBound ? user.clientId : undefined,
    tenantScope: crossTenant ? '*' : 'single',
  });

  return { token, expiresIn };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
