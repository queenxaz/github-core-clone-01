// GraphQL v4 at /api/graphql: a small parser + executor for the documents gh and
// github-mcp-server send (viewer, repository, node, __type, issue/PR connections,
// createIssue/closeIssue/createPullRequest/mergePullRequest/addComment, batched ops).

import type { ServerResponse } from 'node:http';
import {
  Forge, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  diffTrees, mergeableState, squashMerge,
} from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { parseCommitTree } from './git.ts';

// ---------- parser ----------

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

interface FieldNode {
  alias: string;
  name: string;
  args: Record<string, Value>;
  children: FieldNode[] | null;
  fragmentType: string | null; // for "... on Type { ... }" inline fragments
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: FieldNode[];
}

class ParseError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new ParseError('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return t;
  }

  expect(tok: string): void {
    const t = this.next();
    if (t !== tok) throw new ParseError(`expected ${tok}, got ${t}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) ops.push(this.parseOperation());
    return ops;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t === 'query' || t === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '{' && maybeName !== '(') name = this.next();
    // variable definitions
    if (this.peek() === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const tok = this.next();
        if (tok === '(' || tok === '[' || tok === '{') depth += 1;
        else if (tok === ')' || tok === ']' || tok === '}') depth -= 1;
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const children = this.parseSelectionSet();
      return { alias: '', name: '', args: {}, children, fragmentType };
    }
    let alias = '';
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, Value> = {};
    if (this.peek() === '(') args = this.parseArguments();
    let children: FieldNode[] | null = null;
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias: alias || name, name, args, children, fragmentType: null };
  }

  parseArguments(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { __var: this.next() } as unknown as Value;
    if (t === '[') {
      const out: Value[] = [];
      while (this.peek() !== ']') out.push(this.parseValue());
      this.expect(']');
      return out;
    }
    if (t === '{') {
      const out: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        out[key] = this.parseValue();
      }
      this.expect('}');
      return out;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t; // enum value
  }
}

/** Resolve $variables in an argument value. */
function resolveVars(v: Value, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if ('__var' in obj) return vars[obj.__var as string];
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = resolveVars(val as Value, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveVars(x, vars));
  return v;
}

// ---------- introspection data ----------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path'],
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------- executor ----------

interface GqlIssue {
  __typename: 'Issue';
  repo: Repo;
  issue: Issue;
}
interface GqlPull {
  __typename: 'PullRequest';
  repo: Repo;
  pull: Pull;
}
interface GqlRepo {
  __typename: 'Repository';
  repo: Repo;
}
interface GqlUser {
  __typename: 'User';
}
interface GqlConnection {
  __typename: 'IssueConnection' | 'PullRequestConnection';
  nodes: Array<GqlIssue | GqlPull>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface GqlPageInfo {
  __typename: 'PageInfo';
  hasNextPage: boolean;
  endCursor: string | null;
}
interface GqlFile {
  __typename: 'PullRequestChangedFile';
  path: string;
}
interface GqlType {
  __typename: '__Type';
  name: string;
}
interface GqlRef {
  __typename: 'Ref';
  name: string;
}

type GqlObj =
  | GqlIssue
  | GqlPull
  | GqlRepo
  | GqlUser
  | GqlConnection
  | GqlPageInfo
  | GqlFile
  | GqlType
  | GqlRef
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'CreateIssuePayload'; issue: GqlIssue }
  | { __typename: 'CloseIssuePayload'; issue: GqlIssue }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlPull }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlPull }
  | { __typename: 'AddCommentPayload'; commentEdge: { __typename: 'CommentEdge'; node: { __typename: 'Comment'; id: string; body: string } } }
  | { __typename: 'CommentEdge'; node: { __typename: 'Comment'; id: string; body: string } }
  | { __typename: 'Comment'; id: string; body: string };

const FIELD_SETS: Record<string, Set<string>> = {};
for (const [t, fields] of Object.entries(TYPE_FIELDS)) FIELD_SETS[t] = new Set(fields);
FIELD_SETS['__Type'] = new Set(['name', 'kind', 'fields', 'enumValues', 'description']);
FIELD_SETS['__Field'] = new Set(['name']);
FIELD_SETS['__EnumValue'] = new Set(['name']);
FIELD_SETS['CreateIssuePayload'] = new Set(['issue']);
FIELD_SETS['CloseIssuePayload'] = new Set(['issue']);
FIELD_SETS['CreatePullRequestPayload'] = new Set(['pullRequest']);
FIELD_SETS['MergePullRequestPayload'] = new Set(['pullRequest']);
FIELD_SETS['AddCommentPayload'] = new Set(['commentEdge']);
FIELD_SETS['CommentEdge'] = new Set(['node']);
FIELD_SETS['Comment'] = new Set(['id', 'body']);

class GqlError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

export class Executor {
  private readonly forge: Forge;
  constructor(forge: Forge) {
    this.forge = forge;
  }

  executeOperation(op: Operation, vars: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
    try {
      const root: GqlObj = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
      const data = this.select(root, op.fields, vars);
      return { data, errors: [] };
    } catch (err) {
      if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
      throw err;
    }
  }

  private select(parent: GqlObj, fields: FieldNode[], vars: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.fragmentType !== null) {
        // Inline fragment: apply when the parent's concrete type matches.
        if (field.fragmentType === parent.__typename) {
          Object.assign(out, this.select(parent, field.children ?? [], vars));
        }
        continue;
      }
      out[field.alias] = this.resolveField(parent, field, vars);
    }
    return out;
  }

  private resolveField(parent: GqlObj, field: FieldNode, vars: Record<string, unknown>): unknown {
    const typeName = parent.__typename === 'Query' || parent.__typename === 'Mutation' ? parent.__typename : parent.__typename;
    const allowed = FIELD_SETS[typeName];
    if (allowed && !allowed.has(field.name)) {
      throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = resolveVars(v, vars);
    const value = this.fieldValue(parent, field.name, args, field.children, vars);
    if (field.children && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.map((item) =>
          item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
            ? this.select(item as GqlObj, field.children as FieldNode[], vars)
            : item,
        );
      }
      if ('__connection' in (value as Record<string, unknown>)) {
        return this.selectConnection(value as GqlConnection & { __connection: true }, field.children, vars);
      }
      if ('__typename' in (value as Record<string, unknown>)) {
        return this.select(value as GqlObj, field.children, vars);
      }
    }
    return value;
  }

  private selectConnection(conn: GqlConnection & { __connection: true }, fields: FieldNode[], vars: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.name === 'nodes') {
        out[field.alias] = conn.nodes.map((node) => this.select(node, field.children ?? [], vars));
      } else if (field.name === 'pageInfo') {
        const pi: GqlPageInfo = { __typename: 'PageInfo', hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
        out[field.alias] = this.select(pi, field.children ?? [], vars);
      } else if (field.name === 'totalCount') {
        out[field.alias] = conn.nodes.length;
      } else {
        throw new GqlError(`Cannot query field "${field.name}" on type "${conn.__typename}".`);
      }
    }
    return out;
  }

  private fieldValue(parent: GqlObj, name: string, args: Record<string, unknown>, children: FieldNode[] | null, vars: Record<string, unknown>): unknown {
    switch (parent.__typename) {
      case 'Query': {
        if (name === 'viewer') return { __typename: 'User' } as GqlUser;
        if (name === 'repository') {
          const repo = this.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ? ({ __typename: 'Repository', repo } as GqlRepo) : null;
        }
        if (name === 'node') {
          const id = String(args.id ?? '');
          const entry = this.forge.globals.get(id);
          if (!entry) return null;
          if (entry.kind === 'repo') return { __typename: 'Repository', repo: entry.repo } as GqlRepo;
          if (entry.kind === 'issue') {
            const issue = entry.repo.issues.find((i) => i.number === entry.number);
            return issue ? ({ __typename: 'Issue', repo: entry.repo, issue } as GqlIssue) : null;
          }
          if (entry.kind === 'pull') {
            const pull = entry.repo.pulls.find((p) => p.number === entry.number);
            return pull ? ({ __typename: 'PullRequest', repo: entry.repo, pull } as GqlPull) : null;
          }
          return null;
        }
        if (name === '__type') {
          const typeName = String(args.name ?? '');
          if (!TYPE_FIELDS[typeName] && !TYPE_ENUMS[typeName]) return null;
          return { __typename: '__Type', name: typeName } as GqlType;
        }
        throw new GqlError(`Cannot query field "${name}" on type "Query".`);
      }
      case 'Mutation': {
        if (name === 'createIssue') return this.createIssue(args);
        if (name === 'closeIssue') return this.closeIssue(args);
        if (name === 'createPullRequest') return this.createPullRequest(args);
        if (name === 'mergePullRequest') return this.mergePullRequest(args);
        if (name === 'addComment') return this.addComment(args);
        throw new GqlError(`Cannot query field "${name}" on type "Mutation".`);
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        const payload = parent as { __typename: string; issue: GqlIssue };
        if (name === 'issue') return payload.issue;
        throw new GqlError(`Cannot query field "${name}" on type "${parent.__typename}".`);
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        const payload = parent as { __typename: string; pullRequest: GqlPull };
        if (name === 'pullRequest') return payload.pullRequest;
        throw new GqlError(`Cannot query field "${name}" on type "${parent.__typename}".`);
      }
      case 'AddCommentPayload': {
        const payload = parent as { __typename: string; commentEdge: { __typename: 'CommentEdge'; node: { __typename: 'Comment'; id: string; body: string } } };
        if (name === 'commentEdge') return payload.commentEdge;
        throw new GqlError(`Cannot query field "${name}" on type "${parent.__typename}".`);
      }
      case 'CommentEdge': {
        const edge = parent as { __typename: 'CommentEdge'; node: { __typename: 'Comment'; id: string; body: string } };
        if (name === 'node') return edge.node;
        throw new GqlError(`Cannot query field "${name}" on type "CommentEdge".`);
      }
      case 'Comment': {
        const comment = parent as { __typename: 'Comment'; id: string; body: string };
        if (name === 'id') return comment.id;
        if (name === 'body') return comment.body;
        throw new GqlError(`Cannot query field "${name}" on type "Comment".`);
      }
      case 'PullRequestChangedFile': {
        if (name === 'path') return (parent as GqlFile).path;
        throw new GqlError(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
      }
      case 'Repository': {
        const repo = (parent as GqlRepo).repo;
        switch (name) {
          case 'id': return repo.globalId;
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
          case 'owner': return { __typename: 'User' } as GqlUser;
          case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch } as GqlRef;
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'issue': {
            const issue = repo.issues.find((i) => i.number === Number(args.number));
            return issue ? ({ __typename: 'Issue', repo, issue } as GqlIssue) : null;
          }
          case 'issues': return this.issuesConnection(repo, args);
          case 'pullRequests': return this.pullsConnection(repo, args);
          case 'pullRequest': {
            const pull = repo.pulls.find((p) => p.number === Number(args.number));
            return pull ? ({ __typename: 'PullRequest', repo, pull } as GqlPull) : null;
          }
          default: throw new GqlError(`Cannot query field "${name}" on type "Repository".`);
        }
      }
      case 'Issue': {
        const issue = (parent as GqlIssue).issue;
        switch (name) {
          case 'id': return issue.globalId;
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'state': return issueState(issue);
          case 'body': return issue.body;
          default: throw new GqlError(`Cannot query field "${name}" on type "Issue".`);
        }
      }
      case 'PullRequest': {
        const pull = (parent as GqlPull).pull;
        const repo = (parent as GqlPull).repo;
        switch (name) {
          case 'id': return pull.globalId;
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': return pull.body;
          case 'state': return pullState(pull);
          case 'merged': return pull.merged;
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'mergeable': return mergeableState(repo, pull);
          case 'files': {
            const first = typeof args.first === 'number' ? args.first : 10;
            const nodes = pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename }) as GqlFile);
            return { __typename: 'PullRequestConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null }, __connection: true } as unknown as GqlConnection;
          }
          default: throw new GqlError(`Cannot query field "${name}" on type "PullRequest".`);
        }
      }
      case 'User': {
        if (name === 'login') return VIEWER_LOGIN;
        if (name === 'id') return `U_${VIEWER_ID}`;
        if (name === 'name') return VIEWER_NAME;
        if (name === 'email') return VIEWER_EMAIL;
        throw new GqlError(`Cannot query field "${name}" on type "User".`);
      }
      case 'Ref': {
        if (name === 'name') return (parent as GqlRef).name;
        throw new GqlError(`Cannot query field "${name}" on type "Ref".`);
      }
      case 'PageInfo': {
        const pi = parent as GqlPageInfo;
        if (name === 'hasNextPage') return pi.hasNextPage;
        if (name === 'hasPreviousPage') return false;
        if (name === 'endCursor') return pi.endCursor;
        if (name === 'startCursor') return pi.endCursor;
        throw new GqlError(`Cannot query field "${name}" on type "PageInfo".`);
      }
      case '__Type': {
        const typeName = (parent as GqlType).name;
        if (name === 'name') return typeName;
        if (name === 'kind') return TYPE_ENUMS[typeName] ? 'ENUM' : 'OBJECT';
        if (name === 'fields') {
          const fields = TYPE_FIELDS[typeName] ?? [];
          return fields.map((f) => ({ __typename: '__Field', name: f }));
        }
        if (name === 'enumValues') {
          const values = TYPE_ENUMS[typeName] ?? [];
          return values.map((v) => ({ __typename: '__EnumValue', name: v }));
        }
        throw new GqlError(`Cannot query field "${name}" on type "__Type".`);
      }
      case '__Field':
      case '__EnumValue': {
        if (name === 'name') return (parent as { name: string }).name;
        throw new GqlError(`Cannot query field "${name}" on type "${parent.__typename}".`);
      }
      default:
        throw new GqlError(`Cannot query field "${name}" on type "${parent.__typename}".`);
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): GqlConnection & { __connection: true } {
    let list = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const field = orderBy?.field ?? 'CREATED_AT';
    const direction = orderBy?.direction ?? 'DESC';
    if (field === 'CREATED_AT') {
      list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
    }
    const after = numberFromCursor(args.after as string | null | undefined);
    if (after !== null) {
      // Default order is newest first; a cursor resumes after that number.
      list = list.filter((i) => (direction === 'ASC' ? i.number > after : i.number < after));
    }
    const first = typeof args.first === 'number' ? args.first : 10;
    const page = list.slice(0, first);
    const hasNextPage = list.length > first;
    const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue }) as GqlIssue),
      pageInfo: { hasNextPage, endCursor },
      __connection: true,
    } as GqlConnection & { __connection: true };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): GqlConnection & { __connection: true } {
    const first = typeof args.first === 'number' ? args.first : 10;
    const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
    const page = list.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      nodes: page.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as GqlPull),
      pageInfo: { hasNextPage: list.length > first, endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null },
      __connection: true,
    } as GqlConnection & { __connection: true };
  }

  // ---------- mutations ----------

  private createIssue(args: Record<string, unknown>): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const entry = this.forge.globals.get(String(input.repositoryId ?? ''));
    if (!entry || entry.kind !== 'repo') throw new GqlError('Repository not found.');
    const issue = this.forge.createIssue(entry.repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo: entry.repo, issue } as GqlIssue };
  }

  private closeIssue(args: Record<string, unknown>): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const entry = this.forge.globals.get(String(input.issueId ?? ''));
    if (!entry || entry.kind !== 'issue') throw new GqlError('Issue not found.');
    const issue = entry.repo.issues.find((i) => i.number === entry.number);
    if (!issue) throw new GqlError('Issue not found.');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: entry.repo, issue } as GqlIssue };
  }

  private createPullRequest(args: Record<string, unknown>): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const entry = this.forge.globals.get(String(input.repositoryId ?? ''));
    if (!entry || entry.kind !== 'repo') throw new GqlError('Repository not found.');
    const repo = entry.repo;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headTip || !baseTip) throw new GqlError('Head or base branch does not exist.');
    const headCommit = repo.store.get(headTip);
    const baseCommit = repo.store.get(baseTip);
    const headTree = headCommit ? parseCommitTree(headCommit.payload) : null;
    const baseTree = baseCommit ? parseCommitTree(baseCommit.payload) : null;
    const files = diffTrees(repo.store, baseTree, headTree);
    const pull = this.forge.createPull(repo, String(input.title ?? ''), '', headRef, baseRef, baseTip, files);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as GqlPull };
  }

  private mergePullRequest(args: Record<string, unknown>): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const entry = this.forge.globals.get(String(input.pullRequestId ?? ''));
    if (!entry || entry.kind !== 'pull') throw new GqlError('Pull request not found.');
    const pull = entry.repo.pulls.find((p) => p.number === entry.number);
    if (!pull) throw new GqlError('Pull request not found.');
    const result = squashMerge(entry.repo, pull);
    if (!result.merged) throw new GqlError('Pull request cannot be merged.');
    return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo: entry.repo, pull } as GqlPull };
  }

  private addComment(args: Record<string, unknown>): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const entry = this.forge.globals.get(String(input.subjectId ?? ''));
    if (!entry || entry.kind !== 'issue') throw new GqlError('Subject not found.');
    const issue = entry.repo.issues.find((i) => i.number === entry.number);
    if (!issue) throw new GqlError('Issue not found.');
    const comment = this.forge.addComment(entry.repo, issue, String(input.body ?? ''));
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: comment.globalId, body: comment.body } },
    };
  }
}

// ---------- HTTP handler ----------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function handleGraphQL(forge: Forge, bodyRaw: Buffer, authed: boolean, res: ServerResponse): void {
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRaw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  const executor = new Executor(forge);
  const runOne = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request.' }] };
    }
    const obj = item as Record<string, unknown>;
    const query = typeof obj.query === 'string' ? obj.query : '';
    const variables = (obj.variables !== null && typeof obj.variables === 'object' && !Array.isArray(obj.variables) ? obj.variables : {}) as Record<string, unknown>;
    let ops: Operation[];
    try {
      ops = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error.' }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'Empty document.' }] };
    // One operation per body in the suite; run the first (named) operation.
    return executor.executeOperation(ops[0], variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
