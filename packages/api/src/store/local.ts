import fs from 'node:fs/promises';
import path from 'node:path';
import { FILE_TYPES, LOOKUPS, ORGANIZATIONS, type FileTypeDefinition, type LookupList, type Organization, type Submission } from '@odr/shared';
import type { Store, SubmissionFilter } from './types';

interface Db {
  fileTypes: Record<string, FileTypeDefinition>;
  lookups: Record<string, LookupList>;
  organizations: Record<string, Organization>;
  submissions: Record<string, Submission>;
  index: Record<string, string[]>;
}

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.id, structuredClone(i)]));

/**
 * File-backed store for local development: a single JSON document,
 * written atomically after every change. Not for production use.
 */
export class LocalStore implements Store {
  private db?: Db;
  private loading?: Promise<Db>;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'db.json');
  }

  /** Loads (or seeds) the database once; concurrent callers share the same promise. */
  private load(): Promise<Db> {
    this.loading ??= (async () => {
      try {
        const db = JSON.parse(await fs.readFile(this.file, 'utf8')) as Db;
        if (!db.organizations) throw new Error('old format'); // re-seed data from older versions
        this.db = db;
      } catch {
        this.db = { fileTypes: byId(FILE_TYPES), lookups: byId(LOOKUPS), organizations: byId(ORGANIZATIONS), submissions: {}, index: {} };
        await this.persist();
      }
      return this.db;
    })();
    return this.loading;
  }

  private async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.db, null, 2));
    await fs.rename(tmp, this.file);
  }

  /** Serialize writes so concurrent requests can't interleave. */
  private write(fn: (db: Db) => void): Promise<void> {
    const next = this.chain.then(async () => {
      fn(await this.load());
      await this.persist();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async listFileTypes() {
    return Object.values((await this.load()).fileTypes);
  }
  async getFileType(id: string) {
    return (await this.load()).fileTypes[id];
  }
  putFileType(def: FileTypeDefinition) {
    return this.write((db) => void (db.fileTypes[def.id] = def));
  }
  deleteFileType(id: string) {
    return this.write((db) => void delete db.fileTypes[id]);
  }

  async listLookups() {
    return Object.values((await this.load()).lookups);
  }
  putLookup(list: LookupList) {
    return this.write((db) => void (db.lookups[list.id] = list));
  }

  async listOrganizations() {
    return Object.values((await this.load()).organizations);
  }
  async getOrganization(id: string) {
    return (await this.load()).organizations[id];
  }
  putOrganization(org: Organization) {
    return this.write((db) => void (db.organizations[org.id] = org));
  }

  putSubmission(sub: Submission) {
    return this.write((db) => void (db.submissions[sub.id] = sub));
  }
  async getSubmission(id: string) {
    return (await this.load()).submissions[id];
  }
  async listSubmissions(filter: SubmissionFilter) {
    return Object.values((await this.load()).submissions)
      .filter(
        (s) =>
          (!filter.orgId || s.orgId === filter.orgId) &&
          (!filter.submittedBy || (s.submittedBy === filter.submittedBy && !s.orgId)) &&
          (!filter.fileTypeId || s.fileTypeId === filter.fileTypeId),
      )
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, filter.limit ?? 500);
  }

  addIndexValues(scope: string, values: string[]) {
    return this.write((db) => {
      const set = new Set(db.index[scope] ?? []);
      values.forEach((v) => set.add(v));
      db.index[scope] = [...set];
    });
  }
  async getIndexValues(scope: string) {
    return new Set((await this.load()).index[scope] ?? []);
  }
}
