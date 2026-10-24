import type { FileTypeDefinition, LookupList, Organization, Submission } from '@odr/shared';

export interface SubmissionFilter {
  orgId?: string;
  /** Only submissions with no organization made by this user (for users without an organization). */
  submittedBy?: string;
  fileTypeId?: string;
  limit?: number;
}

/** Persistence for configuration and submission history. */
export interface Store {
  listFileTypes(): Promise<FileTypeDefinition[]>;
  getFileType(id: string): Promise<FileTypeDefinition | undefined>;
  putFileType(def: FileTypeDefinition): Promise<void>;
  deleteFileType(id: string): Promise<void>;

  listLookups(): Promise<LookupList[]>;
  putLookup(list: LookupList): Promise<void>;

  listOrganizations(): Promise<Organization[]>;
  getOrganization(id: string): Promise<Organization | undefined>;
  putOrganization(org: Organization): Promise<void>;

  putSubmission(sub: Submission): Promise<void>;
  getSubmission(id: string): Promise<Submission | undefined>;
  /** Newest first. */
  listSubmissions(filter: SubmissionFilter): Promise<Submission[]>;

  /** Values from previously passed files, used by `existsInPrior` rules. Scope = org#fileType#column. */
  addIndexValues(scope: string, values: string[]): Promise<void>;
  getIndexValues(scope: string): Promise<Set<string>>;
}

export const indexScope = (orgId: string | undefined, fileTypeId: string, column: string) => `${orgId ?? '_none'}#${fileTypeId}#${column}`;
