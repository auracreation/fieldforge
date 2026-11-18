export function validRef(ref) {
  return typeof ref === 'string' && /^refs\/(heads|tags)\/[^\x00-\x20\x7f~^:?*\[\\]+$/.test(ref)
    && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//')
    && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock') && !part.endsWith('.'));
}
