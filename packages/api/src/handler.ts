import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from './config';
import { HttpError, json, matchRoute, type RequestContext, type Route } from './http';
import { adminRoutes } from './routes/admin';
import { configRoutes } from './routes/config';
import { submissionRoutes } from './routes/submissions';
import { services } from './services';

const routes: Route[] = [
  { method: 'GET', pattern: '/api/health', public: true, handler: async () => ({ ok: true, mode: config.mode }) },
  {
    method: 'GET',
    pattern: '/api/auth/config',
    public: true,
    handler: async () =>
      config.mode === 'aws'
        ? { mode: 'cognito', userPoolId: config.aws.userPoolId, clientId: config.aws.userPoolClientId, region: config.aws.region }
        : { mode: 'local' },
  },
  {
    // Demo sign-in. Only exists in local mode; in AWS the browser signs in with Cognito directly.
    method: 'POST',
    pattern: '/api/auth/login',
    public: true,
    handler: async (req) => {
      const localAuth = services().localAuth;
      if (!localAuth) throw new HttpError(404, 'Not found.');
      const { email, password } = req.body<{ email?: string; password?: string }>();
      const result = await localAuth.login(email ?? '', password ?? '');
      if (!result) throw new HttpError(401, 'Incorrect email or password.');
      return result;
    },
  },
  {
    method: 'GET',
    pattern: '/api/me',
    handler: async (req) => req.user,
  },
  ...configRoutes,
  ...submissionRoutes,
  ...adminRoutes,
];

/** AWS Lambda entry point (API Gateway HTTP API, payload v2). Also used by the local server. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath;
  try {
    const match = matchRoute(routes, method, path);
    if (!match) throw new HttpError(404, `No route for ${method} ${path}`);

    const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const user = await services().auth.verify(token);
    if (!match.route.public && !user) throw new HttpError(401, 'Sign in required.');

    const req: RequestContext = {
      event,
      method,
      path,
      params: match.params,
      query: event.queryStringParameters ?? {},
      user,
      body: <T>() => {
        if (!event.body) return {} as T;
        const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
        try {
          return JSON.parse(raw) as T;
        } catch {
          throw new HttpError(400, 'Request body must be valid JSON.');
        }
      },
    };
    const result = await match.route.handler(req);
    return json(200, result ?? null);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { message: e.message, details: e.details });
    console.error('Unhandled error', e);
    return json(500, { message: 'Something went wrong. Please try again.' });
  }
}
