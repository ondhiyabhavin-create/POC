import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobStore } from './types';

const EXPIRY_SECONDS = 300;

export class S3BlobStore implements BlobStore {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region });
  }

  async put(key: string, body: string | Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = Buffer.from(await res.Body!.transformToByteArray());
      return { body, size: body.length };
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }

  signedUploadUrl(key: string, contentType: string) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: EXPIRY_SECONDS });
  }

  signedDownloadUrl(key: string, downloadName: string) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"`,
      }),
      { expiresIn: EXPIRY_SECONDS },
    );
  }
}
