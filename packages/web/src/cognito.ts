/**
 * Amazon Cognito sign-in (used only when the API reports mode "cognito").
 * Loaded lazily so local mode never pulls in the Cognito SDK.
 */
import { AuthenticationDetails, CognitoUser, CognitoUserPool, type CognitoUserSession } from 'amazon-cognito-identity-js';

export type CognitoResult = { kind: 'ok'; idToken: string } | { kind: 'newPasswordRequired'; complete: (newPassword: string) => Promise<CognitoResult> };

export function cognitoSignIn(userPoolId: string, clientId: string, email: string, password: string): Promise<CognitoResult> {
  const pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });

  return new Promise((resolve, reject) => {
    const callbacks = {
      onSuccess: (session: CognitoUserSession) => resolve({ kind: 'ok', idToken: session.getIdToken().getJwtToken() }),
      onFailure: (err: Error) => reject(err),
      newPasswordRequired: () =>
        resolve({
          kind: 'newPasswordRequired',
          complete: (newPassword: string) =>
            new Promise<CognitoResult>((res, rej) =>
              user.completeNewPasswordChallenge(newPassword, {}, {
                onSuccess: (session) => res({ kind: 'ok', idToken: session.getIdToken().getJwtToken() }),
                onFailure: rej,
              }),
            ),
        }),
    };
    user.authenticateUser(details, callbacks);
  });
}

export function cognitoSignOut(userPoolId: string, clientId: string) {
  new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId }).getCurrentUser()?.signOut();
}
