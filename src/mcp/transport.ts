import { need } from '../storage/store.ts';
const spec = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([k, type]) => [k, { type }])), required, additionalProperties: false } });
const tools = [
  spec('create_repo', 'Create a repository in the authenticated namespace.', { name: 'string', description: 'string', private: 'boolean' }, ['name']),
  spec('get_repo', 'Read a repository by owner and name.', { owner: 'string', repo: 'string' }, ['owner', 'repo']),
  spec('create_issue', 'Create an issue in a repository.', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']),
  spec('list_issues', 'List repository issues by state.', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']),
  spec('create_pull_request', 'Open a pull request between repository branches.', { owner: 'string', repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string' }, ['owner', 'repo', 'title', 'head', 'base']),
  spec('merge_pull_request', 'Squash merge a pull request.', { owner: 'string', repo: 'string', pull_number: 'number' }, ['owner', 'repo', 'pull_number']),
  spec('get_file_contents', 'Read file content or directory entries.', { owner: 'string', repo: 'string', path: 'string', ref: 'string' }, ['owner', 'repo', 'path']),
  spec('create_or_update_file', 'Commit base64 encoded file contents.', { owner: 'string', repo: 'string', path: 'string', content: 'string', message: 'string', sha: 'string', branch: 'string' }, ['owner', 'repo', 'path', 'content', 'message'])
];
const info = { name: 'Standalone Forge', version: '1.0.0' };
export function mcp(store, request) {
  if (Array.isArray(request)) return request.map(r => mcp(store, r)).filter(Boolean);
  const id = request?.id ?? null;
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid Request');
  if (!('id' in request)) return null;
  let result;
  if (request.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], serverInfo: info, capabilities: { tools: {} } };
  else if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', serverInfo: info, capabilities: { tools: {} } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call') {
    const name = request.params?.name, a = request.params?.arguments, schema = tools.find(t => t.name === name);
    if (!schema) return error(-32602, 'Unknown tool');
    if (!a || typeof a !== 'object' || Array.isArray(a) || schema.inputSchema.required.some(k => !(k in a)) || Object.entries(a).some(([k, v]) => !schema.inputSchema.properties[k] || typeof v !== schema.inputSchema.properties[k].type)) return error(-32602, 'Invalid arguments');
    try {
      const r = name === 'create_repo' ? null : store.repo(a.owner, a.repo); let value;
      if (name === 'create_repo') value = store.repoJson(store.createRepo(a));
      else if (name === 'get_repo') value = store.repoJson(r);
      else if (name === 'create_issue') value = store.issueJson(store.createIssue(r, a));
      else if (name === 'list_issues') value = { issues: [...r.issues.values()].filter(i => a.state === 'all' || i.state === (a.state ?? 'open')).map(i => store.issueJson(i)) };
      else if (name === 'create_pull_request') value = store.pullJson(store.createPull(r, a));
      else if (name === 'merge_pull_request') value = store.mergePull(need(r.pulls.get(a.pull_number)));
      else if (name === 'get_file_contents') value = store.content(r, a.path, a.ref);
      else if (name === 'create_or_update_file') value = store.writeFile(r, a.path, a);
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (e) { result = { content: [{ type: 'text', text: e.message }], isError: true }; }
  } else return error(-32601, 'Method not found');
  return { jsonrpc: '2.0', id, result };
}
