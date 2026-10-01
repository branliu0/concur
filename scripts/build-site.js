// Assembles the web page into _site/: the page itself, core.js, and the two
// libraries it imports, copied out of node_modules.  No bundler - the imports
// of those libraries by package name are just pointed at the copies.
//
//   npm run site && npx serve _site
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concur } from '../src/core.js';
import { env } from '../src/node-env.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = (name) => path.join(root, 'node_modules', name);
const site = path.join(root, '_site');
const cp = (from, to) => fs.cpSync(from, path.join(site, to), { recursive: true });

fs.rmSync(site, { recursive: true, force: true });
cp(path.join(root, 'web'), '.');
cp(path.join(root, 'src/core.js'), 'core.js');
cp(path.join(pkg('@cantoo/pdf-lib'), 'dist/pdf-lib.esm.min.js'), 'vendor/pdf-lib.mjs');
const pdfjs = pkg('pdfjs-dist');
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs']) {
  cp(path.join(pdfjs, f), `vendor/pdfjs/${path.basename(f)}`);
}
// fonts and decoders pdf.js fetches on demand while rendering
for (const d of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) cp(path.join(pdfjs, d), `vendor/pdfjs/${d}`);
// each example gets its 2-up made by the tool itself, to sit beside it
const examples = path.join(site, 'examples');
for (const f of fs.existsSync(examples) ? fs.readdirSync(examples) : []) {
  if (!f.endsWith('.pdf')) continue;
  const { pdf } = await concur(new Uint8Array(fs.readFileSync(path.join(examples, f))), {}, env);
  fs.writeFileSync(path.join(examples, f.replace(/\.pdf$/, '-2up.pdf')), pdf);
}

// the scripting sandbox for PDF forms, which nothing here uses
for (const f of fs.readdirSync(path.join(site, 'vendor/pdfjs/wasm'))) {
  if (f.startsWith('quickjs')) fs.rmSync(path.join(site, 'vendor/pdfjs/wasm', f));
}

// a browser cannot resolve a package name, so name the files
const vendored = { '@cantoo/pdf-lib': './vendor/pdf-lib.mjs', 'pdfjs-dist': './vendor/pdfjs/pdf.min.mjs' };
for (const f of ['core.js', 'app.js']) {
  let js = fs.readFileSync(path.join(site, f), 'utf8');
  for (const [name, file] of Object.entries(vendored)) js = js.replaceAll(`from '${name}'`, `from '${file}'`);
  fs.writeFileSync(path.join(site, f), js);
}

// the service worker's list of everything to keep for offline use, and a
// version that changes whenever any of it does
const files = fs.readdirSync(site, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name !== 'sw.js')
  .map((d) => path.relative(site, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
  // the examples are for looking at, not for working offline with
  .filter((f) => !f.startsWith('examples/'))
  .sort();
const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(site, f)));
const sw = fs.readFileSync(path.join(site, 'sw.js'), 'utf8')
  .replace('__VERSION__', `concur-${hash.digest('hex').slice(0, 12)}`)
  .replace('__FILES__', JSON.stringify(['./', ...files.map((f) => `./${f}`)]));
fs.writeFileSync(path.join(site, 'sw.js'), sw);

// stop GitHub Pages running the site through Jekyll
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`built ${path.relative(root, site)}/`);
// pdf.js keeps a worker alive that would otherwise hold the process open
process.exit(0);
