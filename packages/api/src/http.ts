import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { UserIdentity } from '@odr/shared';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = 'You do not have access to this resource.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);

export interface RequestContext {
  event: APIGatewayProxyEventV2;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: <T = unknown>() => T;
  user: UserIdentity | null;
}

export type Route = {
  method: string;
  pattern: string;
  /** Routes are authenticated unless marked public. */
  public?: boolean;
  handler: (req: RequestContext) => Promise<unknown>;
};

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pp = route.pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

export function json(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

export function requireUser(req: RequestContext): UserIdentity {
  if (!req.user) throw new HttpError(401, 'Sign in required.');
  return req.user;
}

export function requireAdmin(req: RequestContext): UserIdentity {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden('Administrator access required.');
  return user;
}
