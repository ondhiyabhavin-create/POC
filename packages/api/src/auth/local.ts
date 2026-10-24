import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { UserIdentity } from '@odr/shared';
import type { Authenticator } from './types';

/**
 * Demo accounts for local development only. In AWS these come from Cognito:
 * the `admin` group maps to role admin; `custom:orgId` (optional) links a user to an organization.
 */
export const LOCAL_PASSWORD = 'Password1!';
export const LOCAL_USERS: UserIdentity[] = [
  { sub: 'local-admin', email: 'admin@demo.local', name: 'Rules Admin (Demo)', role: 'admin' },
  { sub: 'local-ccsv', email: 'user@ccsv.local', name: 'Somewhereville Court Clerk (Demo)', role: 'user', orgId: 'CCSV' },
  { sub: 'local-bpu', email: 'user@bpu.local', name: 'Bayou Parish Billing (Demo)', role: 'user', orgId: 'BPU' },
  { sub: 'local-guest', email: 'anyone@demo.local', name: 'Any User (Demo)', role: 'user' },
];

export class LocalAuthenticator implements Authenticator {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async login(email: string, password: string): Promise<{ token: string; user: UserIdentity } | null> {
    const user = LOCAL_USERS.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    const a = Buffer.from(password);
    const b = Buffer.from(LOCAL_PASSWORD);
    if (!user || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const token = await new SignJWT({ email: user.email, name: user.name, role: user.role, orgId: user.orgId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(this.key);
    return { token, user };
  }

  async verify(token: string | undefined): Promise<UserIdentity | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      return {
        sub: String(payload.sub),
        email: String(payload.email),
        name: String(payload.name),
        role: payload.role === 'admin' ? 'admin' : 'user',
        orgId: payload.orgId ? String(payload.orgId) : undefined,
      };
    } catch {
      return null;
    }
  }
}
