import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.ts';
import { rest } from '../src/api/rest.ts';
import { graphql } from '../src/graphql/executor.ts';
const setup = () => { const s = new Store('alice'), r = s.createRepo({ name: 'sample' }); return { s, r }; };
const call = (s, method, path, body = {}) => rest(s, method, new URL('http://localhost/api/v3/repos/alice/sample' + path), body);
function file(s, r, path, text, branch = 'main') { const sha = s.resolve(r, branch) ? s.content(r, path, branch)?.sha : undefined; return s.writeFile(r, path, { message: text, content: Buffer.from(text).toString('base64'), branch, ...(sha ? { sha } : {}) }); }
const mutation = 'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{number noSuchField}}}';
test('GraphQL validates complete selections before mutations', () => {
  const { s, r } = setup(); const before = s.export();
  const out = graphql(s, { query: mutation, variables: { input: { repositoryId: r.node_id, title: 'bad selection' } } });
  assert(out.errors); assert.equal(s.export(), before);
});
test('GraphQL query roots cannot execute mutations', () => {
  const { s, r } = setup(); const before = s.export();
  const out = graphql(s, { query: 'query($input:CreateIssueInput!){createIssue(input:$input){issue{number}}}', variables: { input: { repositoryId: r.node_id, title: 'wrong operation' } } });
  assert(out.errors); assert.equal(s.export(), before);
});
test('GraphQL validates declared required variables and types', () => {
  const { s, r } = setup();
  assert(graphql(s, { query: 'query($required:Int!){viewer{login}}' }).errors);
  assert(graphql(s, { query: 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){number}}}', variables: { owner: 'alice', name: r.name, n: '1' } }).errors);
});
test('REST ref creation rejects noncommit targets and malformed names', () => {
  const { s, r } = setup(); const result = file(s, r, 'a.txt', 'first');
  assert.throws(() => call(s, 'POST', '/git/refs', { ref: 'refs/heads/blob', sha: result.content.sha }), { status: 422 });
  assert.throws(() => call(s, 'POST', '/git/refs', { ref: 'refs/heads/../escape', sha: result.commit.sha }), { status: 422 });
});
test('pull request representations follow branch updates and report non-newline lines', () => {
  const { s, r } = setup(); file(s, r, 'a.txt', 'first'); r.refs.set('refs/heads/head', s.resolve(r));
  s.writeFile(r, 'new.txt', { message: 'add', content: Buffer.from('one line').toString('base64'), branch: 'head' });
  const p = s.createPull(r, { title: 'change', base: 'main', head: 'head' });
  file(s, r, 'a.txt', 'second', 'head');
  assert.equal(s.pullJson(p).head.sha, s.resolve(r, 'head'));
  assert(s.pullFiles(p).find(f => f.filename === 'new.txt').additions >= 1);
  s.mergePull(p);
  const out = graphql(s, { query: '{repository(owner:"alice",name:"sample"){pullRequest(number:1){state merged}}}' });
  assert.equal(out.data.repository.pullRequest.state, 'MERGED');
});
test('invalid input does not change store or create unreachable objects', () => {
  const { s, r } = setup(); file(s, r, 'a.txt', 'first'); const before = s.export();
  assert.throws(() => s.createRepo({ name: 'invalid', private: 'yes' }), { status: 422 });
  assert.throws(() => s.createRepo({ name: 'invalid', description: {} }), { status: 422 });
  assert.throws(() => s.writeFile(r, 'a.txt/child', { message: 'collision', content: 'eA==' }), { status: 422 });
  assert.equal(s.export(), before);
});
test('unknown owner lookup cannot rename repositories during identity bootstrap', () => {
  const s = new Store(), r = s.createRepo({ name: 'new' });
  assert.throws(() => s.repo('stranger', 'missing')); assert.equal(s.login, ''); assert.equal(r.owner.login, 'forge');
});
test('directory entries name tree IDs and deleting a repo releases comments', () => {
  const { s, r } = setup(); s.writeFile(r, 'nested/file.txt', { message: 'nested', content: 'eA==' });
  const directory = s.content(r, '', 'main').find(e => e.name === 'nested');
  assert.equal(r.objects.get(directory.sha).type, 'tree');
  const issue = s.createIssue(r, { title: 'comment' }), comment = s.comment(issue, 'reply');
  const other = s.createRepo({ name: 'other' });
  call(s, 'DELETE', '');
  assert(!s.ids.has(comment.node_id)); assert(s.ids.has(other.node_id));
});
test('null PATCH is a validation error', () => {
  const { s } = setup(); assert.throws(() => call(s, 'PATCH', '', null), { status: 422 });
});
test('valid GraphQL issue mutation payload needs no lookup number', () => {
  const { s, r } = setup();
  const result = graphql(s, { query: 'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{number id title}}}', variables: { input: { repositoryId: r.node_id, title: 'created by GraphQL' } } });
  assert.equal(result.errors, undefined); assert.equal(r.issues.get(result.data.createIssue.issue.number).title, 'created by GraphQL');
});
test('invalid GraphQL directives cannot cause mutation side effects', () => {
  const { s, r } = setup(); const before = s.export();
  const out = graphql(s, { query: 'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{number @include(if:$missing)}}}', variables: { input: { repositoryId: r.node_id, title: 'must not exist' } } });
  assert(out.errors); assert.equal(s.export(), before);
});
test('REST pull updates validate all fields atomically', () => {
  const { s, r } = setup(); file(s,r,'a.txt','one');r.refs.set('refs/heads/head',s.resolve(r));
  const p=s.createPull(r,{title:'original',head:'head',base:'main'});const before=s.export();
  assert.throws(()=>call(s,'PATCH','/pulls/'+p.number,{title:123,body:{bad:true},state:'merged'}),{status:422});assert.equal(s.export(),before);
});
test('GraphQL merged pull filter matches its published state and file stats count edits', () => {
  const { s, r } = setup();file(s,r,'a.txt','a\nb\nc\n');r.refs.set('refs/heads/head',s.resolve(r));file(s,r,'a.txt','a\nchanged\nc\n','head');
  const p=s.createPull(r,{title:'one change',head:'head',base:'main'});const diff=s.pullFiles(p)[0];assert.equal(diff.additions,1);assert.equal(diff.deletions,1);
  s.mergePull(p);const out=graphql(s,{query:'{repository(owner:"alice",name:"sample"){pullRequests(states:[MERGED],first:10){nodes{number state}}}}'});
  assert.equal(out.errors,undefined);assert.equal(out.data.repository.pullRequests.nodes[0].state,'MERGED');
});
