import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { loadEnv } from '../config/env.js';
import type { AuthenticatedUser, JwtPayload, Role } from '../authz/types.js';

const JWT_EXPIRES_IN_SECONDS = 8 * 60 * 60;

export function signToken(input: {
  userId: string;
  role: Role;
  tenantId?: string;
  tenantScope?: '*' | 'single';
}): { token: string; expiresIn: number; jti: string } {
  const env = loadEnv();
  const jti = uuidv4();
  const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
    userId: input.userId,
    role: input.role,
    jti,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.tenantScope === '*' ? { tenantScope: '*' as const } : {}),
  };

  const token = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN_SECONDS,
  });

  return { token, expiresIn: JWT_EXPIRES_IN_SECONDS, jti };
}

export function verifyToken(token: string): JwtPayload {
  const env = loadEnv();
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export function toAuthenticatedUser(payload: JwtPayload): AuthenticatedUser {
  const tenantScope = payload.tenantScope === '*' ? '*' : 'single';
  return {
    userId: payload.userId,
    role: payload.role,
    tenantId: payload.tenantId,
    tenantScope,
    jti: payload.jti,
  };
}
