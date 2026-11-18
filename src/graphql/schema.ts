export const SCHEMA = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'ReopenIssuePayload', addComment: 'AddCommentPayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  User: { id: 'ID', login: 'String', name: 'String' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'String', createdAt: 'String', updatedAt: 'String', repository: 'Repository', comments: 'IssueCommentConnection' },
  PullRequest: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', headRefName: 'String', baseRefName: 'String', state: 'String', merged: 'Boolean', mergeable: 'String', files: 'PullRequestChangedFileConnection' },
  IssueComment: { id: 'ID', body: 'String' }, PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int' },
  Ref: { name: 'String', target: 'Commit' }, Commit: { oid: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Type: { name: 'String', fields: '__Field', enumValues: '__EnumValue' }, __Field: { name: 'String' }, __EnumValue: { name: 'String' },
  CreateIssuePayload: { issue: 'Issue' }, CloseIssuePayload: { issue: 'Issue' }, ReopenIssuePayload: { issue: 'Issue' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' }, CreatePullRequestPayload: { pullRequest: 'PullRequest' }, MergePullRequestPayload: { pullRequest: 'PullRequest' },
  Node: { id: 'ID' }
};
for (const type of ['Issue','PullRequest','IssueComment','PullRequestChangedFile']) {
  SCHEMA[type+'Connection'] = { totalCount: 'Int', nodes: type, edges: type+'Edge', pageInfo: 'PageInfo' };
  SCHEMA[type+'Edge'] = { node: type, cursor: 'String' };
}
const INPUTS = {
  CreateIssueInput: { repositoryId:'ID!', title:'String!', body:'String', clientMutationId:'String' },
  CloseIssueInput: { issueId:'ID!', stateReason:'String', clientMutationId:'String' },
  ReopenIssueInput: { issueId:'ID!', clientMutationId:'String' },
  AddCommentInput: { subjectId:'ID!', body:'String!', clientMutationId:'String' },
  CreatePullRequestInput: { repositoryId:'ID!', title:'String!', body:'String', headRefName:'String!', baseRefName:'String!', draft:'Boolean', clientMutationId:'String' },
  MergePullRequestInput: { pullRequestId:'ID!', mergeMethod:'String', clientMutationId:'String' }
};
export function validateValue(value,type,label) {
  if (type.endsWith('!')) { if (value==null) throw new Error(`${label} is required`); return validateValue(value,type.slice(0,-1),label); }
  if (value==null) return;
  if (type.startsWith('[')) { const items=Array.isArray(value)?value:[value]; for (const v of items) validateValue(v,type.slice(1,-1),label); return; }
  if (INPUTS[type]) {
    if (typeof value!=='object' || Array.isArray(value)) throw new Error(`${label} must be an input object`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(INPUTS[type],key)) throw new Error(`Unknown input field ${key}`);
    for (const [key,child] of Object.entries(INPUTS[type])) validateValue(value[key],child,`${label}.${key}`);
    return;
  }
  if ((type==='String'||type==='ID') ? typeof value!=='string' : type==='Int' ? !Number.isInteger(value)||value<-(2**31)||value>=2**31 : type==='Boolean' ? typeof value!=='boolean' : type==='Float' ? typeof value!=='number'||!Number.isFinite(value) : false) throw new Error(`${label} has invalid type ${type}`);
}
export function validateSelection(selection,type,fragments,resolve,active=new Set()) {
  for (const node of selection) {
    if (node.spread) { if(active.has(node.spread))throw new Error('Fragment cycle'); const f=fragments[node.spread]; if(!f)throw new Error('Unknown fragment'); const next=new Set(active);next.add(node.spread);validateSelection(f.selection,f.type,fragments,resolve,next);continue; }
    if (node.inline) { if(!SCHEMA[node.inline])throw new Error('Unknown fragment type');validateSelection(node.selection,node.inline,fragments,resolve,active);continue; }
    const child=node.field==='__typename'?'String':SCHEMA[type]?.[node.field];
    if (!child) throw new Error(`Cannot query field "${node.field}" on type "${type}".`);
    const args=resolve(node.args);
    for (const directive of node.directives) {
      if(!['include','skip'].includes(directive.name))throw new Error(`Unknown directive ${directive.name}`);
      validateValue(resolve(directive.args).if,'Boolean!',directive.name+'.if');
    }
    if (type==='Mutation') {
      const inputType={createIssue:'CreateIssueInput',closeIssue:'CloseIssueInput',reopenIssue:'ReopenIssueInput',addComment:'AddCommentInput',createPullRequest:'CreatePullRequestInput',mergePullRequest:'MergePullRequestInput'}[node.field];
      validateValue(args.input,inputType+'!',node.field+'.input');
    }
    if (type==='Query' && node.field==='repository') {validateValue(args.owner,'String!','owner');validateValue(args.name,'String!','name');}
    if (type==='Repository' && (node.field==='issue'||node.field==='pullRequest'))validateValue(args.number,'Int!','number');
    if (SCHEMA[child]) { if(!node.selection)throw new Error(`Field ${node.field} needs a selection`);validateSelection(node.selection,child,fragments,resolve,active); }
    else if (node.selection)throw new Error(`Field ${node.field} cannot have a selection`);
  }
}
