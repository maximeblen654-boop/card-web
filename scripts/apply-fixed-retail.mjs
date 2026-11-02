// Local distribution patch: auto_sync_price=false also protects explicit
// markup recalculation. Applied only to the reviewed pinned upstream file.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const originalHash = 'c4cff67866d9dd3fcdd343ccd6a6e3038b0c84368c55520e63a69fb12e9550eb';
const hash = text => createHash('sha256').update(text).digest('hex');
const anchor = '\n\tmappings, err := s.mappings.ListActiveByConnection(connectionID)';
const guard = '\n\t// Fixed retail prices must survive connection edits and manual markup reapply.\n\tif !conn.AutoSyncPrice {\n\t\treturn 0, nil\n\t}\n';
const filename = resolve(process.argv[2] || 'upstream', 'internal/modules/catalog/mapping/application/markup.go');
const source = readFileSync(filename, 'utf8');
if (source.includes(guard) && hash(source.replace(guard, '')) === originalHash) {
  console.log('Fixed retail guard already applied.');
} else {
  if (hash(source) !== originalHash || source.split(anchor).length !== 2) {
    throw new Error('Unreviewed upstream pricing source; refusing to patch.');
  }
  const patched = source.replace(anchor, guard + anchor);
  writeFileSync(filename, patched);
  if (readFileSync(filename, 'utf8') !== patched) throw new Error('Patch verification failed.');
  console.log('Fixed retail guard applied to pinned upstream source.');
}
