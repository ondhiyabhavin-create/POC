/** Object storage for uploaded files and generated reports. */
export interface BlobStore {
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  /** Returns undefined when the object does not exist. */
  get(key: string): Promise<{ body: Buffer; size: number } | undefined>;
  /** URL the browser can PUT the raw file to. */
  signedUploadUrl(key: string, contentType: string): Promise<string>;
  delete(key: string): Promise<void>;
  /** Short-lived URL the browser can GET to download the object. */
  signedDownloadUrl(key: string, downloadName: string): Promise<string>;
}
