// Dry-runs every PDF in samples/ and compares the report with
// samples/expected-js.txt.  samples/ is not in git: put your own PDFs there,
// run with --update once to record what they report, and after that a plain
// run shows whether a change moved any of them.
//
//   npm test             compare
//   npm test -- --update record what it reports now
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'samples');
const expectedFile = path.join(dir, 'expected-js.txt');

const report = (name) => {
  const r = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '-n', path.join(dir, name)],
    { encoding: 'utf8' });
  return (r.stdout + r.stderr).trimEnd();
};

if (process.argv.includes('--update')) {
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort() : [];
  if (!names.length) {
    console.log('no PDFs in samples/ to record');
    process.exit(1);
  }
  fs.writeFileSync(expectedFile, names.map((n) => `== ${n}\n${report(n)}\n`).join(''));
  console.log(`wrote ${names.length} reports to samples/expected-js.txt`);
  process.exit(0);
}

if (!fs.existsSync(expectedFile)) {
  console.log('nothing to compare: no samples/expected-js.txt (see the top of this file)');
  process.exit(0);
}
const expected = new Map();
for (const chunk of fs.readFileSync(expectedFile, 'utf8').split(/^== /m).slice(1)) {
  const [name, ...lines] = chunk.trimEnd().split('\n');
  expected.set(name, lines.join('\n'));
}

let failed = 0, missing = 0;
for (const [name, want] of expected) {
  if (!fs.existsSync(path.join(dir, name))) {
    console.log(`?  ${name} (not in samples/)`);
    missing++;
    continue;
  }
  const got = report(name);
  if (got === want) {
    console.log(`ok ${name}`);
    continue;
  }
  failed++;
  console.log(`XX ${name}`);
  const g = got.split('\n'), w = want.split('\n');
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] === w[i]) continue;
    if (w[i] !== undefined) console.log(`   - ${w[i]}`);
    if (g[i] !== undefined) console.log(`   + ${g[i]}`);
  }
}
console.log(`\n${expected.size - failed - missing} ok, ${failed} differ, ${missing} missing`);
process.exit(failed ? 1 : 0);
