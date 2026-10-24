import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { FILE_TYPES, LOOKUPS, ORGANIZATIONS, type FileTypeDefinition, type LookupList, type Organization, type Submission } from '@odr/shared';
import type { Store, SubmissionFilter } from './types';

/**
 * DynamoDB single-table store.
 *
 *   pk                    sk                       item
 *   FILETYPE              <fileTypeId>             FileTypeDefinition
 *   LOOKUP                <lookupId>               LookupList
 *   ORG                   <orgId>                  Organization
 *   SUBMISSION            <submittedAt>#<id>       Submission
 *   SUBMISSION_ID         <id>                     pointer { sk }
 *   INDEX#<scope>         <value>                  {}   (values from passed files, for cross-file rules)
 *
 * Partition-per-entity-type is fine at POC volumes (~50 files/week).
 */
export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;
  private seeded?: Promise<void>;

  constructor(
    private readonly table: string,
    region: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async queryAll<T>(input: Omit<QueryCommandInput, 'TableName'>, max = Infinity): Promise<T[]> {
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ TableName: this.table, ...input, ExclusiveStartKey }));
      out.push(...((res.Items ?? []) as T[]));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < max);
    return out;
  }

  private strip<T>(item: Record<string, unknown>): T {
    const { pk: _pk, sk: _sk, ...rest } = item;
    return rest as T;
  }

  private async put(pk: string, sk: string, item: object) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk, sk, ...item } }));
  }

  private async list<T>(pk: string): Promise<T[]> {
    await this.ensureSeeded();
    const items = await this.queryAll<Record<string, unknown>>({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
    });
    return items.map((i) => this.strip<T>(i));
  }

  private async get<T>(pk: string, sk: string): Promise<T | undefined> {
    await this.ensureSeeded();
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return res.Item ? this.strip<T>(res.Item) : undefined;
  }

  /** First run against an empty table loads the default rule sets. */
  private ensureSeeded(): Promise<void> {
    this.seeded ??= (async () => {
      const existing = await this.doc.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'FILETYPE' }, Limit: 1 }),
      );
      if ((existing.Items ?? []).length > 0) return;
      for (const f of FILE_TYPES) await this.put('FILETYPE', f.id, f);
      for (const l of LOOKUPS) await this.put('LOOKUP', l.id, l);
      for (const o of ORGANIZATIONS) await this.put('ORG', o.id, o);
    })().catch((e) => {
      this.seeded = undefined;
      throw e;
    });
    return this.seeded;
  }

  listFileTypes() {
    return this.list<FileTypeDefinition>('FILETYPE');
  }
  getFileType(id: string) {
    return this.get<FileTypeDefinition>('FILETYPE', id);
  }
  putFileType(def: FileTypeDefinition) {
    return this.put('FILETYPE', def.id, def);
  }

  listLookups() {
    return this.list<LookupList>('LOOKUP');
  }
  putLookup(list: LookupList) {
    return this.put('LOOKUP', list.id, list);
  }

  async deleteFileType(id: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'FILETYPE', sk: id } }));
  }

  listOrganizations() {
    return this.list<Organization>('ORG');
  }
  getOrganization(id: string) {
    return this.get<Organization>('ORG', id);
  }
  putOrganization(org: Organization) {
    return this.put('ORG', org.id, org);
  }

  async putSubmission(sub: Submission) {
    const sk = `${sub.submittedAt}#${sub.id}`;
    await this.put('SUBMISSION', sk, sub);
    await this.put('SUBMISSION_ID', sub.id, { ref: sk });
  }
  async getSubmission(id: string) {
    const ptr = await this.get<{ ref: string }>('SUBMISSION_ID', id);
    return ptr ? this.get<Submission>('SUBMISSION', ptr.ref) : undefined;
  }
  async listSubmissions(filter: SubmissionFilter) {
    await this.ensureSeeded();
    const limit = filter.limit ?? 500;
    const conditions: string[] = [];
    const values: Record<string, unknown> = { ':pk': 'SUBMISSION' };
    if (filter.orgId) {
      conditions.push('orgId = :o');
      values[':o'] = filter.orgId;
    }
    if (filter.submittedBy) {
      conditions.push('submittedBy = :u AND attribute_not_exists(orgId)');
      values[':u'] = filter.submittedBy;
    }
    if (filter.fileTypeId) {
      conditions.push('fileTypeId = :f');
      values[':f'] = filter.fileTypeId;
    }
    const items = await this.queryAll<Record<string, unknown>>(
      {
        KeyConditionExpression: 'pk = :pk',
        ScanIndexForward: false,
        ExpressionAttributeValues: values,
        ...(conditions.length ? { FilterExpression: conditions.join(' AND ') } : {}),
      },
      limit,
    );
    return items.slice(0, limit).map((i) => this.strip<Submission>(i));
  }

  async addIndexValues(scope: string, values: string[]) {
    const unique = [...new Set(values)];
    for (let i = 0; i < unique.length; i += 25) {
      let requests: Record<string, unknown[]> | undefined = {
        [this.table]: unique.slice(i, i + 25).map((v) => ({ PutRequest: { Item: { pk: `INDEX#${scope}`, sk: v } } })),
      };
      for (let attempt = 0; requests && Object.keys(requests).length && attempt < 5; attempt++) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: requests as never }));
        requests = res.UnprocessedItems as Record<string, unknown[]> | undefined;
        if (requests && Object.keys(requests).length) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  }
  async getIndexValues(scope: string) {
    const items = await this.queryAll<{ sk: string }>({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `INDEX#${scope}` },
      ProjectionExpression: 'sk',
    });
    return new Set(items.map((i) => i.sk));
  }
}
