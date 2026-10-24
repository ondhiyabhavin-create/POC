import { checkFileTypeDefinition, columnLetter, type FileTypeDefinition, type LookupList, type Organization } from '@odr/shared';
import { HttpError, badRequest, forbidden, notFound, requireAdmin, requireUser, type Route } from '../http';
import { services } from '../services';

const now = () => new Date().toISOString();

export const configRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/api/file-types',
    handler: async (req) => {
      const user = requireUser(req);
      const all = await services().store.listFileTypes();
      const visible = user.role === 'admin' ? all : all.filter((f) => f.active);
      return visible.sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  {
    method: 'GET',
    pattern: '/api/file-types/:id',
    handler: async (req) => {
      const user = requireUser(req);
      const def = await services().store.getFileType(req.params.id);
      if (!def || (!def.active && user.role !== 'admin')) throw notFound('File type not found.');
      return def;
    },
  },
  {
    method: 'PUT',
    pattern: '/api/file-types/:id',
    handler: async (req) => {
      const user = requireAdmin(req);
      const { store } = services();
      const input = req.body<FileTypeDefinition>();
      if (input.id !== req.params.id) throw badRequest('File type code in the URL and body must match.');
      const [existing, all, lookups] = await Promise.all([store.getFileType(input.id), store.listFileTypes(), store.listLookups()]);
      if (req.query.create === '1' && existing) throw badRequest(`A file type with code "${input.id}" already exists. Choose another code.`);
      const def: FileTypeDefinition = {
        ...input,
        columns: (input.columns ?? []).map((c, i) => ({ ...c, letter: columnLetter(i) })),
        rowRules: input.rowRules ?? [],
        fileRules: input.fileRules ?? [],
        headerMatch: input.headerMatch === 'strict' ? 'strict' : 'relaxed',
        fileNamePattern: input.fileNamePattern?.trim() || undefined,
        version: (existing?.version ?? 0) + 1,
        updatedAt: now(),
        updatedBy: user.email,
      };
      const problems = checkFileTypeDefinition(def, lookups, all.map((f) => f.id));
      if (problems.length) throw badRequest('The rule set has problems that must be fixed before saving.', problems);
      await store.putFileType(def);
      return def;
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/file-types/:id',
    handler: async (req) => {
      const user = requireAdmin(req);
      const { store } = services();
      const all = await store.listFileTypes();
      if (!all.some((f) => f.id === req.params.id)) throw notFound('File type not found.');
      const refersTo = (r: FileTypeDefinition['fileRules'][number]) => r.type === 'existsInPrior' && r.sourceFileTypeId === req.params.id;
      const users = all.filter((f) => f.id !== req.params.id && f.fileRules.some(refersTo));
      if (users.length && req.query.cascade !== '1') {
        throw new HttpError(409, `${users.map((u) => u.name).join(', ')} check values against this file type.`, { referencedBy: users.map((u) => ({ id: u.id, name: u.name })) });
      }
      // Cascade: remove the rules that point at the deleted type.
      for (const u of users) {
        await store.putFileType({ ...u, fileRules: u.fileRules.filter((r) => !refersTo(r)), version: u.version + 1, updatedAt: now(), updatedBy: user.email });
      }
      await store.deleteFileType(req.params.id);
      return { deleted: req.params.id, updated: users.map((u) => u.id) };
    },
  },
  {
    method: 'GET',
    pattern: '/api/lookups',
    handler: async (req) => {
      requireUser(req);
      return (await services().store.listLookups()).sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  {
    method: 'PUT',
    pattern: '/api/lookups/:id',
    handler: async (req) => {
      requireAdmin(req);
      const input = req.body<LookupList>();
      if (!/^[A-Z][A-Z0-9_]*$/.test(req.params.id)) throw badRequest('Lookup list ID must be UPPER_SNAKE_CASE.');
      if (!input.name?.trim()) throw badRequest('Lookup list name is required.');
      const values = [...new Set((input.values ?? []).map((v) => String(v).trim()).filter(Boolean))];
      if (values.length === 0) throw badRequest('A lookup list needs at least one value.');
      const list: LookupList = { id: req.params.id, name: input.name.trim(), description: input.description, values, updatedAt: now() };
      await services().store.putLookup(list);
      return list;
    },
  },
  {
    method: 'GET',
    pattern: '/api/organizations',
    handler: async (req) => {
      const user = requireUser(req);
      const all = await services().store.listOrganizations();
      const visible = user.role === 'admin' ? all : all.filter((o) => o.id === user.orgId);
      return visible.sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  {
    method: 'GET',
    pattern: '/api/organizations/:id',
    handler: async (req) => {
      const user = requireUser(req);
      if (user.role !== 'admin' && user.orgId !== req.params.id) throw forbidden();
      const org = await services().store.getOrganization(req.params.id);
      if (!org) throw notFound('Organization not found.');
      return org;
    },
  },
  {
    method: 'PUT',
    pattern: '/api/organizations/:id',
    handler: async (req) => {
      requireAdmin(req);
      const input = req.body<Organization>();
      if (input.id !== req.params.id) throw badRequest('Organization ID in the URL and body must match.');
      if (!/^[A-Za-z0-9]+$/.test(input.id)) throw badRequest('Organization ID may contain only letters and digits.');
      if (!/^[A-Za-z0-9]+$/.test(input.code ?? '')) throw badRequest('Code may contain only letters and digits (it is used in file names).');
      if (!input.name?.trim()) throw badRequest('Name is required.');
      const attributes: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.attributes ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw badRequest(`Attribute key "${k}" must start with a letter and contain only letters, digits or _.`);
        attributes[k] = String(v ?? '');
      }
      const org: Organization = { id: input.id, code: input.code, name: input.name.trim(), active: input.active !== false, attributes };
      await services().store.putOrganization(org);
      return org;
    },
  },
];
