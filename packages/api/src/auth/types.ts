import type { UserIdentity } from '@odr/shared';

export interface Authenticator {
  /** Resolve a bearer token to a user, or null if it is missing/invalid. */
  verify(token: string | undefined): Promise<UserIdentity | null>;
}
