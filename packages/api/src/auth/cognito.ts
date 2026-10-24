import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { UserIdentity } from '@odr/shared';
import type { Authenticator } from './types';

/**
 * Verifies Cognito ID tokens. Role comes from Cognito groups; users may carry an
 * optional `custom:orgId` attribute linking them to an organization.
 */
export class CognitoAuthenticator implements Authenticator {
  private readonly verifier;

  constructor(
    userPoolId: string,
    clientId: string,
    private readonly adminGroup: string,
  ) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  }

  async verify(token: string | undefined): Promise<UserIdentity | null> {
    if (!token) return null;
    try {
      const p = await this.verifier.verify(token);
      const groups = (p['cognito:groups'] as string[] | undefined) ?? [];
      const isAdmin = groups.includes(this.adminGroup);
      const orgId = (p['custom:orgId'] as string | undefined) || undefined;
      return {
        sub: p.sub,
        email: String(p.email ?? ''),
        name: String(p.name ?? p.email ?? p['cognito:username'] ?? ''),
        role: isAdmin ? 'admin' : 'user',
        orgId: isAdmin ? undefined : orgId,
      };
    } catch {
      return null;
    }
  }
}
