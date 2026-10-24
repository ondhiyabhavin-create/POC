import { config } from './config';
import { CognitoAuthenticator } from './auth/cognito';
import { LocalAuthenticator } from './auth/local';
import type { Authenticator } from './auth/types';
import { LocalBlobStore } from './blobs/local';
import { S3BlobStore } from './blobs/s3';
import type { BlobStore } from './blobs/types';
import { DynamoStore } from './store/dynamo';
import { LocalStore } from './store/local';
import type { Store } from './store/types';
import path from 'node:path';

export interface Services {
  store: Store;
  blobs: BlobStore;
  auth: Authenticator;
  /** Present only in local mode. */
  localAuth?: LocalAuthenticator;
}

let cached: Services | undefined;

/** Wire implementations based on APP_MODE. Created once per Lambda container / process. */
export function services(): Services {
  if (cached) return cached;
  if (config.mode === 'aws') {
    const aws = config.aws;
    cached = {
      store: new DynamoStore(aws.tableName, aws.region),
      blobs: new S3BlobStore(aws.bucketName, aws.region),
      auth: new CognitoAuthenticator(aws.userPoolId, aws.userPoolClientId, aws.adminGroup),
    };
  } else {
    const l = config.local;
    const localAuth = new LocalAuthenticator(l.jwtSecret);
    cached = {
      store: new LocalStore(l.dataDir),
      blobs: new LocalBlobStore(path.join(l.dataDir, 'files'), l.publicUrl, l.jwtSecret),
      auth: localAuth,
      localAuth,
    };
  }
  return cached;
}
