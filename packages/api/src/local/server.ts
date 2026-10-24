/**
 * Local development server. Translates plain HTTP requests into API Gateway
 * v2 events and calls the same Lambda handler that runs in AWS. Also serves the
 * signed local file URLs that stand in for S3 presigned URLs.
 */
import http from 'node:http';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { config } from '../config';
import { handler } from '../handler';
import { LocalBlobStore } from '../blobs/local';
import { services } from '../services';

if (config.mode !== 'local') {
  console.error('The local server only runs with APP_MODE=local.');
  process.exit(1);
}

const readBody = (req: http.IncomingMessage, limit: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', config.local.publicUrl);
  // Browser uploads/downloads go straight here (like S3), so allow the Vite origin.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,PUT,POST,PATCH,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    if (url.pathname.startsWith('/local-files/')) {
      const blobs = services().blobs as LocalBlobStore;
      const key = url.pathname.slice('/local-files/'.length).split('/').map(decodeURIComponent).join('/');
      const expires = url.searchParams.get('expires') ?? '';
      const sig = url.searchParams.get('sig') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const method = req.method ?? 'GET';
      if (!blobs.verify(method, key, expires, sig, name)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Link expired or invalid.');
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req, config.maxUploadBytes);
        await blobs.put(key, body);
        res.writeHead(200).end();
      } else {
        const obj = await blobs.get(key);
        if (!obj) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'content-type': key.endsWith('.json') ? 'application/json' : key.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
          'content-disposition': `attachment; filename="${(name || key.split('/').pop() || 'file').replace(/[^\w.-]/g, '_')}"`,
        });
        res.end(obj.body);
      }
      return;
    }

    const body = await readBody(req, 1024 * 1024);
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')])),
      queryStringParameters: Object.fromEntries(url.searchParams),
      requestContext: { http: { method: req.method ?? 'GET', path: url.pathname } },
      body: body.length ? body.toString('utf8') : undefined,
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;

    const result = await handler(event);
    res.writeHead(result.statusCode ?? 200, result.headers as http.OutgoingHttpHeaders);
    res.end(result.body ?? '');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Local server error' }));
  }
});

server.listen(config.local.port, () => {
  console.log(`ODR File Intake API (local mode) on ${config.local.publicUrl}`);
  console.log(`Data directory: ${config.local.dataDir}`);
});
