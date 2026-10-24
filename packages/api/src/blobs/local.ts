import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from './types';

const EXPIRY_SECONDS = 300;

/**
 * Local-disk stand-in for S3. Upload/download URLs are HMAC-signed and
 * short-lived, mirroring S3 presigned URLs, and are served by the local server.
 */
export class LocalBlobStore implements BlobStore {
  constructor(
    private readonly dir: string,
    private readonly publicUrl: string,
    private readonly secret: string,
  ) {}

  private resolve(key: string) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('Invalid object key');
    return full;
  }

  async put(key: string, body: string | Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string) {
    try {
      const body = await fs.readFile(this.resolve(key));
      return { body, size: body.length };
    } catch {
      return undefined;
    }
  }

  sign(method: string, key: string, expires: number, name = '') {
    return crypto.createHmac('sha256', this.secret).update(`${method}\n${key}\n${expires}\n${name}`).digest('hex');
  }

  verify(method: string, key: string, expires: string, signature: string, name = '') {
    if (!/^\d+$/.test(expires) || Number(expires) < Date.now() / 1000) return false;
    const expected = this.sign(method, key, Number(expires), name);
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  private url(method: string, key: string, name = '') {
    const expires = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;
    const q = new URLSearchParams({ expires: String(expires), sig: this.sign(method, key, expires, name) });
    if (name) q.set('name', name);
    return `${this.publicUrl}/local-files/${key.split('/').map(encodeURIComponent).join('/')}?${q}`;
  }

  async signedUploadUrl(key: string) {
    return this.url('PUT', key);
  }

  async signedDownloadUrl(key: string, downloadName: string) {
    return this.url('GET', key, downloadName);
  }
}
