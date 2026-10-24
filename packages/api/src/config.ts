/**
 * Runtime configuration. Everything switches on APP_MODE:
 *   local – JSON files + local file storage + built-in demo login (no AWS needed)
 *   aws   – DynamoDB + S3 + Amazon Cognito
 */
import path from 'node:path';

export type AppMode = 'local' | 'aws';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
};

export const config = {
  mode: (process.env.APP_MODE ?? 'local') as AppMode,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? '25') * 1024 * 1024,
  /** Issues kept inline on the submission record; the full list lives in object storage. */
  previewIssueCount: 50,
  local: {
    port: Number(process.env.PORT ?? '4000'),
    dataDir: process.env.LOCAL_DATA_DIR ?? path.resolve(process.cwd(), '.data'),
    publicUrl: process.env.LOCAL_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? '4000'}`,
    jwtSecret: process.env.LOCAL_JWT_SECRET ?? 'local-dev-only-secret-change-me-0123456789',
  },
  get aws() {
    return {
      region: env('AWS_REGION', 'us-east-1'),
      tableName: env('TABLE_NAME'),
      bucketName: env('BUCKET_NAME'),
      userPoolId: env('COGNITO_USER_POOL_ID'),
      userPoolClientId: env('COGNITO_CLIENT_ID'),
      adminGroup: process.env.COGNITO_ADMIN_GROUP ?? 'admin',
    };
  },
};
