import { parse } from './parser.ts';
import { need } from '../storage/store.ts';
import { SCHEMA, validateSelection, validateValue } from './schema.ts';
const typed = (type, values) => ({ __typename: type, ...values });
export function graphql(store, request) {
  if (Array.isArray(request)) return request.map(r => graphql(store, r));
  try {
    const { operation, fragments, resolve, variables } = parse(request?.query, request?.variables ?? {}, request?.operationName);
    for (const [key,type] of Object.entries(operation.types)) validateValue(variables[key],type,'$'+key);
    validateSelection(operation.selection,operation.type==='mutation'?'Mutation':'Query',fragments,resolve);
    function connection(items, args, convert) {
      const start = args.after ? Number(Buffer.from(args.after, 'base64url').toString().replace('cursor:', '')) + 1 : 0;
      need(Number.isSafeInteger(start) && start >= 0, 422, 'Invalid cursor');
      const limit = Math.min(100, Math.max(0, args.first ?? args.last ?? 30));
      const nodes = items.slice(start, start + limit).map(convert), cursor = i => Buffer.from('cursor:' + i).toString('base64url');
      return typed('Connection', { totalCount: items.length, nodes, edges: nodes.map((node, i) => typed('Edge', { node, cursor: cursor(start + i) })), pageInfo: typed('PageInfo', { hasNextPage: start + nodes.length < items.length, hasPreviousPage: start > 0, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null, startCursor: nodes.length ? cursor(start) : null }) });
    }
    const user = u => typed('User', { id: 'VXNlcjox', login: u.login, name: u.login });
    const comment = c => typed('IssueComment', { id: c.node_id, body: c.body });
    const issue = i => i ? typed('Issue', { id: i.node_id, databaseId: i.id, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: i.created_at, updatedAt: i.updated_at, repository: () => repository(i.repo), comments: a => connection(i.comments, a, comment) }) : null;
    const pull = p => p ? typed('PullRequest', { id: p.node_id, databaseId: p.id, number: p.number, title: p.title, body: p.body, headRefName: p.head.ref, baseRefName: p.base.ref, state: p.merged?'MERGED':p.state.toUpperCase(), merged: p.merged, mergeable: 'UNKNOWN', files: a => connection(store.pullFiles(p), a, f => typed('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions })) }) : null;
    function repository(r) {
      return r ? typed('Repository', {
        id: r.node_id, databaseId: r.id, name: r.name, nameWithOwner: `${r.owner.login}/${r.name}`, owner: user(r.owner), viewerPermission: 'ADMIN', hasIssuesEnabled: true,
        defaultBranchRef: () => store.resolve(r) ? typed('Ref', { name: r.default_branch, target: typed('Commit', { oid: store.resolve(r) }) }) : null,
        issue: a => issue(r.issues.get(a.number)), pullRequest: a => pull(r.pulls.get(a.number)),
        issues: a => { const list = [...r.issues.values()].filter(i => !a.states || a.states.includes(i.state.toUpperCase())); if (a.orderBy?.direction === 'DESC') list.reverse(); return connection(list, a, issue); },
        pullRequests: a => connection([...r.pulls.values()].filter(p => !a.states || a.states.includes(p.merged?'MERGED':p.state.toUpperCase())), a, pull)
      }) : null;
    }
    function byId(id, type) { const found = need(store.ids.get(id), 422, 'Unknown node ID'); need(!type || found.type === type, 422, 'Invalid node type'); return found.value; }
    const root = typed(operation.type === 'mutation' ? 'Mutation' : 'Query', {
      viewer: () => user(store.user()),
      repository: a => { if(!store.repos.has(a.name))return null;store.bind(a.owner); return a.owner === store.login ? repository(store.repos.get(a.name)) : null; },
      node: a => { const found = store.ids.get(a.id); return found ? ({ Repository: repository, Issue: issue, PullRequest: pull, IssueComment: comment }[found.type]?.(found.value) ?? null) : null; },
      __type: a => typed('__Type', { name: a.name, fields: () => Object.keys(SCHEMA[a.name] ?? {}).map(name => typed('__Field', { name })), enumValues: () => a.name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map(name => typed('__EnumValue', { name })) : [] }),
      createIssue: a => typed('CreateIssuePayload', { issue: issue(store.createIssue(byId(a.input.repositoryId, 'Repository'), a.input)) }),
      closeIssue: a => typed('CloseIssuePayload', { issue: issue(store.updateIssue(byId(a.input.issueId, 'Issue'), { state: 'closed' })) }),
      reopenIssue: a => typed('ReopenIssuePayload', { issue: issue(store.updateIssue(byId(a.input.issueId, 'Issue'), { state: 'open' })) }),
      addComment: a => typed('AddCommentPayload', { commentEdge: typed('IssueCommentEdge', { node: comment(store.comment(byId(a.input.subjectId, 'Issue'), a.input.body)) }) }),
      createPullRequest: a => { const input = a.input, p = store.createPull(byId(input.repositoryId, 'Repository'), { ...input, head: input.headRefName, base: input.baseRefName }); return typed('CreatePullRequestPayload', { pullRequest: pull(p) }); },
      mergePullRequest: a => { const p = byId(a.input.pullRequestId, 'PullRequest'); store.mergePull(p); return typed('MergePullRequestPayload', { pullRequest: pull(p) }); }
    });
    function evaluate(object, selection, active = new Set()) {
      if (object == null) return null;
      if (Array.isArray(object)) return object.map(item => evaluate(item, selection, active));
      const out = {};
      for (const node of selection) {
        if (node.spread) { if (active.has(node.spread)) throw new Error('Fragment cycle'); const f = fragments[node.spread]; if (!f) throw new Error('Unknown fragment'); if (f.type === object.__typename) { const next = new Set(active); next.add(node.spread); Object.assign(out, evaluate(object, f.selection, next)); } continue; }
        if (node.inline) { if (node.inline === object.__typename) Object.assign(out, evaluate(object, node.selection, active)); continue; }
        if (node.directives.some(d => (d.name === 'skip' && resolve(d.args).if) || (d.name === 'include' && !resolve(d.args).if))) continue;
        if (!Object.hasOwn(object, node.field)) throw new Error(`Cannot query field "${node.field}" on type "${object.__typename}".`);
        let v = object[node.field]; if (typeof v === 'function') v = v(resolve(node.args));
        out[node.alias] = node.selection ? evaluate(v, node.selection, active) : v;
      }
      return out;
    }
    return { data: evaluate(root, operation.selection) };
  } catch (e) { return { data: null, errors: [{ message: e.message }] }; }
}
