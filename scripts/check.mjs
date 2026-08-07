import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);
for (const file of files.filter(f => /\.(js|mjs)$/.test(f))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
const forbidden = /\b(TODO|FIXME|MOCK|placeholder implementation)\b/i;
const offenders = files.filter(f => !f.endsWith('scripts/check.mjs') && /\.(js|mjs|html|css|md|json)$/.test(f) && forbidden.test(readFileSync(f, 'utf8')));
if (offenders.length) throw new Error(`Forbidden unfinished markers: ${offenders.map(f => relative(root, f)).join(', ')}`);
execFileSync(process.execPath, ['--test', join(root, 'tests', '*.test.js')], { stdio: 'inherit', shell: true });
console.log(`Checked ${files.length} project files.`);
