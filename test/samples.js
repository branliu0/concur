// Dry-runs a set of PDFs and compares what each reports with what was
// recorded, so a change that moves any of them shows up.
//
// The default set is samples/, which is not in git: put your own PDFs there
// and run with --update once to record them. --examples runs the web page's
// two public examples instead, recorded in test/examples-expected.txt; that is
// the set GitHub checks before publishing.
//
//   npm test                         compare samples/
//   npm test -- --update             record what samples/ reports now
//   npm test -- --examples [--update]  the same for the examples
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examples = process.argv.includes('--examples');
const dir = path.join(root, examples ? 'web/examples' : 'samples');
const expectedFile = examples ? path.join(root, 'test/examples-expected.txt')
  : path.join(dir, 'expected-js.txt');
const where = path.relative(root, expectedFile);

const report = (name) => {
  const r = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '-n', path.join(dir, name)],
    { encoding: 'utf8' });
  return (r.stdout + r.stderr).trimEnd();
};

if (process.argv.includes('--update')) {
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'))
      // an example's hand-made 2-per-page version is not concur's to measure
      .filter((f) => !f.includes('--manual')).sort() : [];
  if (!names.length) {
    console.log(`no PDFs in ${path.relative(root, dir)}/ to record`);
    process.exit(1);
  }
  fs.writeFileSync(expectedFile, names.map((n) => `== ${n}\n${report(n)}\n`).join(''));
  console.log(`wrote ${names.length} reports to ${where}`);
  process.exit(0);
}

if (!fs.existsSync(expectedFile)) {
  console.log(`nothing to compare: no ${where} (see the top of this file)`);
  process.exit(examples ? 1 : 0);
}
const expected = new Map();
for (const chunk of fs.readFileSync(expectedFile, 'utf8').split(/^== /m).slice(1)) {
  const [name, ...lines] = chunk.trimEnd().split('\n');
  expected.set(name, lines.join('\n'));
}

let failed = 0, missing = 0;
for (const [name, want] of expected) {
  if (!fs.existsSync(path.join(dir, name))) {
    console.log(`?  ${name} (not in ${path.relative(root, dir)}/)`);
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
process.exit(failed || (examples && missing) ? 1 : 0);
