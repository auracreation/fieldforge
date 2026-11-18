import { inflateSync, deflateSync } from 'node:zlib';
import { hash, objectId } from './objects.ts';
const TYPES = [null,'commit','tree','blob','tag'];
const MAX = 32 * 1024 * 1024;
// Git objects are immutable; weak keys release compressed bytes with their repository.
let compressed = new WeakMap(), compressedBytes = 0;
const COMPRESSED_LIMIT = 8 * 1024 * 1024;
export function applyDelta(base, delta, remaining = 128 * 1024 * 1024) {
  let at = 0;
  function size() { let n = 0, factor = 1, byte; do { if (at >= delta.length || factor > 2 ** 35) throw new Error('truncated delta'); byte = delta[at++]; n += (byte & 127) * factor; factor *= 128; } while (byte & 128); return n; }
  if (size() !== base.length) throw new Error('delta base size');
  const length = size(); if (length > MAX) throw new Error('delta size limit');
  if (length > remaining) throw new Error('pack expanded size limit');
  const out = Buffer.alloc(length); let written = 0;
  while (at < delta.length) {
    const op = delta[at++]; let offset = 0, count = 0;
    if (op & 128) {
      for (let i = 0; i < 4; i++) if (op & (1 << i)) { if (at >= delta.length) throw new Error('delta copy'); offset += delta[at++] * 2 ** (8 * i); }
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) { if (at >= delta.length) throw new Error('delta copy'); count += delta[at++] * 2 ** (8 * i); }
      if (!count) count = 65536;
      if (offset + count > base.length || written + count > length) throw new Error('delta copy bounds');
      base.copy(out, written, offset, offset + count);
    } else {
      count = op; if (!count || at + count > delta.length || written + count > length) throw new Error('delta insert bounds');
      delta.copy(out, written, at, at + count); at += count;
    }
    written += count;
  }
  if (written !== length) throw new Error('delta result size'); return out;
}
export function readPack(bytes, existing = new Map()) {
  if (bytes.length < 32 || bytes.toString('ascii',0,4) !== 'PACK' || ![2,3].includes(bytes.readUInt32BE(4))) throw new Error('pack header');
  if (hash(bytes.subarray(0,-20)) !== bytes.subarray(-20).toString('hex')) throw new Error('pack checksum');
  const count = bytes.readUInt32BE(8); if (count > 100000) throw new Error('pack object count');
  let at = 12, total = 0; const entries = [], offsets = new Map(), resolved = new Map();
  for (let i = 0; i < count; i++) {
    const start = at; if (at >= bytes.length - 20) throw new Error('pack truncated');
    let byte = bytes[at++], type = (byte >> 4) & 7, size = byte & 15, factor = 16;
    while (byte & 128) { if (at >= bytes.length - 20 || factor > 2 ** 35) throw new Error('pack size'); byte = bytes[at++]; size += (byte & 127) * factor; factor *= 128; }
    if (size > MAX || (total += size) > 128 * 1024 * 1024) throw new Error('pack size limit');
    let base;
    if (type === 6) { byte = bytes[at++]; let distance = byte & 127; while (byte & 128) { if (at >= bytes.length - 20) throw new Error('delta offset'); byte = bytes[at++]; distance = (distance + 1) * 128 + (byte & 127); } base = start - distance; if (base >= start || !offsets.has(base)) throw new Error('delta offset'); }
    else if (type === 7) { if (at + 20 > bytes.length - 20) throw new Error('delta reference'); base = bytes.subarray(at,at+20).toString('hex'); at += 20; }
    else if (!TYPES[type]) throw new Error('pack object type');
    const inflated = inflateSync(bytes.subarray(at,-20), { info: true, maxOutputLength: MAX });
    at += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size');
    const e = { type, data: inflated.buffer, base, start }; entries.push(e); offsets.set(start,e);
  }
  if (at !== bytes.length - 20) throw new Error('pack trailing data');
  let pending = entries, expanded = 0;
  while (pending.length) {
    const next = [];
    for (const e of pending) {
      if (e.type === 6 || e.type === 7) {
        const b = typeof e.base === 'number' ? offsets.get(e.base)?.object : resolved.get(e.base) ?? existing.get(e.base);
        if (!b) { next.push(e); continue; }
        e.object = { type: b.type, data: applyDelta(b.data,e.data,128 * 1024 * 1024 - expanded) };
      } else e.object = { type: TYPES[e.type], data: e.data };
      expanded += e.object.data.length;
      if (expanded > 128 * 1024 * 1024) throw new Error('pack expanded size limit');
      e.sha = objectId(e.object.type,e.object.data); resolved.set(e.sha,e.object);
    }
    if (next.length === pending.length) throw new Error('unresolved delta'); pending = next;
  }
  return resolved;
}
function header(type, length) {
  const out = []; let n = length; out.push((TYPES.indexOf(type) << 4) | (n & 15)); n = Math.floor(n / 16);
  while (n) { out[out.length - 1] |= 128; out.push(n & 127); n = Math.floor(n / 128); } return Buffer.from(out);
}
export function writePack(objects) {
  const prefix = Buffer.alloc(12); prefix.write('PACK'); prefix.writeUInt32BE(2,4); prefix.writeUInt32BE(objects.length,8);
  const body = Buffer.concat([prefix,...objects.map(o => {
    let entry = compressed.get(o);
    if (!entry) {
      entry = Buffer.concat([header(o.type,o.data.length),deflateSync(o.data,{level:1})]);
      if (entry.length <= COMPRESSED_LIMIT) {
        if (compressedBytes + entry.length > COMPRESSED_LIMIT) { compressed = new WeakMap(); compressedBytes = 0; }
        compressed.set(o,entry); compressedBytes += entry.length;
      }
    }
    return entry;
  })]);
  return Buffer.concat([body,Buffer.from(hash(body),'hex')]);
}
