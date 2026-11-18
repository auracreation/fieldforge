export function parse(query, variables = {}, operationName) {
  if (typeof query !== 'string' || query.length > 1024 * 1024) throw new Error('Invalid GraphQL document');
  const tokens = [], pattern = /\s+|#[^\n\r]*|,|\.\.\.|[A-Za-z_][A-Za-z_0-9]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|"(?:[^"\\\r\n]|\\.)*"|[!$():=@\[\]{}|]/y;
  let offset = 0;
  while (offset < query.length) {
    pattern.lastIndex = offset; const match = pattern.exec(query);
    if (!match) throw new Error(`Unexpected character at ${offset}`);
    offset = pattern.lastIndex; const token = match[0];
    if (!/^[\s,#]/.test(token)) tokens.push(token);
    if (tokens.length > 100000) throw new Error('Document token limit');
  }
  let at = 0, depth = 0; const fragments = {}, operations = [];
  const take = () => { if (at >= tokens.length) throw new Error('Unexpected end of GraphQL document'); return tokens[at++]; };
  const expect = token => { if (take() !== token) throw new Error(`Expected ${token}`); };
  const name = () => { const token = take(); if (!/^[A-Za-z_]\w*$/.test(token)) throw new Error(`Expected name, got ${token}`); return token; };
  function value() {
    if (++depth > 64) throw new Error('Value depth limit');
    const token = take(); let out;
    if (token === '$') out = { variable: name() };
    else if (token === '[') { out = []; while (tokens[at] !== ']') out.push(value()); expect(']'); }
    else if (token === '{') { out = Object.create(null); while (tokens[at] !== '}') { const key = name(); expect(':'); out[key] = value(); } expect('}'); }
    else if (token.startsWith('"')) out = JSON.parse(token);
    else if (token === 'null') out = null;
    else if (token === 'true' || token === 'false') out = token === 'true';
    else if (/^-?\d/.test(token)) out = Number(token);
    else if (/^[A-Za-z_]\w*$/.test(token)) out = token;
    else throw new Error(`Invalid value ${token}`);
    depth--; return out;
  }
  function args() {
    const out = Object.create(null); if (tokens[at] !== '(') return out;
    take(); while (tokens[at] !== ')') { const key = name(); expect(':'); out[key] = value(); } expect(')'); return out;
  }
  function selection() {
    if (++depth > 64) throw new Error('Selection depth limit'); expect('{'); const out = [];
    while (tokens[at] !== '}') {
      if (tokens[at] === '...') {
        take(); const n = name();
        if (n === 'on') { const type = name(); out.push({ inline: type, selection: selection() }); }
        else out.push({ spread: n });
        continue;
      }
      let field = name(), alias = field; if (tokens[at] === ':') { take(); field = name(); }
      const arguments_ = args(), directives = [];
      while (tokens[at] === '@') { take(); directives.push({ name: name(), args: args() }); }
      out.push({ field, alias, args: arguments_, directives, selection: tokens[at] === '{' ? selection() : null });
    }
    expect('}'); depth--; return out;
  }
  while (at < tokens.length) {
    if (tokens[at] === 'fragment') { take(); const n = name(); expect('on'); const type = name(); fragments[n] = { type, selection: selection() }; continue; }
    const defaults = {}, types = {}; let type = 'query', n;
    if (tokens[at] !== '{') {
      type = name(); if (!['query', 'mutation'].includes(type)) throw new Error('Unsupported operation');
      if (tokens[at] !== '(' && tokens[at] !== '{') n = name();
      if (tokens[at] === '(') {
        take();
        while (tokens[at] !== ')') {
          expect('$'); const key = name(); expect(':'); let nesting = 0, declaration = '';
          do { const token = take(); declaration += token; if (token === '[') nesting++; else if (token === ']') nesting--; } while (nesting > 0 || tokens[at] === '!');
          if (!/^\[*[A-Za-z_]\w*!?(?:\]!?)*$/.test(declaration)) throw new Error('Invalid variable type');
          types[key] = declaration;
          if (tokens[at] === '=') { take(); defaults[key] = value(); }
        }
        expect(')');
      }
    }
    operations.push({ type, name: n, defaults, types, selection: selection() });
  }
  const operation = operationName ? operations.find(o => o.name === operationName) : operations.length === 1 ? operations[0] : null;
  if (!operation) throw new Error('Choose a valid operationName');
  const vars = { ...operation.defaults, ...variables };
  function resolve(v) {
    if (v && typeof v === 'object') {
      if (Object.keys(v).length === 1 && 'variable' in v) { if (!(v.variable in vars)) throw new Error(`Missing variable ${v.variable}`); return vars[v.variable]; }
      if (Array.isArray(v)) return v.map(resolve);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  }
  return { operation, fragments, resolve, variables: vars };
}
