// Assembles the web page into _site/: the page itself, core.js, and the two
// libraries it imports, copied out of node_modules.  No bundler - the imports
// of those libraries by package name are just pointed at the copies.
//
//   npm run site && npx serve _site
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, decodePDFRawStream } from '@cantoo/pdf-lib';
import { concur } from '../src/core.js';
import { env } from '../src/node-env.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = (name) => path.join(root, 'node_modules', name);
const site = path.join(root, '_site');
const cp = (from, to) => fs.cpSync(from, path.join(site, to), { recursive: true });
const pct = (x) => `${Math.round(x * 100)}%`;

// How much a print dialog shrank the pages: macOS draws each one inside
// "q s 0 0 s x y cm ... Q", so take the commonest such s on the sheets.
async function printedScale(bytes) {
  const doc = await PDFDocument.load(bytes);
  const counts = new Map();
  for (const page of doc.getPages().slice(0, 10)) {
    for (const ref of [page.node.Contents()].flat().flatMap((c) => c?.asArray?.() ?? [c])) {
      const stream = doc.context.lookup(ref);
      if (!stream) continue;
      const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const [, s] of text.matchAll(/\bq\s+([\d.]+)\s+0\s+0\s+\1\s+[-\d.]+\s+[-\d.]+\s+cm\b/g)) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
  }
  if (!counts.size) throw new Error('cannot tell how much a --manual example was shrunk');
  return Number([...counts].sort((a, b) => b[1] - a[1])[0][0]);
}

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
// Each example is shown two ways: printed two per page the usual way, made by
// hand in a print dialog (<name>--manual.pdf), and with concur, made here.
const examples = path.join(site, 'examples');
const scales = {};   // how big the text comes out, for the page to quote
const linked = new Set([...fs.readFileSync(path.join(site, 'index.html'), 'utf8')
  .matchAll(/examples\/([\w-]+)\.pdf/g)].map((m) => m[1]));
for (const f of fs.existsSync(examples) ? fs.readdirSync(examples) : []) {
  const stem = f.replace(/\.pdf$/, '');
  // only the files the page links to; anything else in there stays out
  if (!f.endsWith('.pdf') || !linked.has(stem)) {
    fs.rmSync(path.join(examples, f));
    continue;
  }
  const bytes = fs.readFileSync(path.join(examples, f));
  if (stem.endsWith('--manual')) {
    scales[stem] = pct(await printedScale(bytes));
  } else if (linked.has(`${stem}-concur`)) {
    const { pdf, scale } = await concur(new Uint8Array(bytes), {}, env);
    fs.writeFileSync(path.join(examples, `${stem}-concur.pdf`), pdf);
    scales[`${stem}-concur`] = pct(scale);
  }
}

// the scripting sandbox for PDF forms, which nothing here uses
for (const f of fs.readdirSync(path.join(site, 'vendor/pdfjs/wasm'))) {
  if (f.startsWith('quickjs')) fs.rmSync(path.join(site, 'vendor/pdfjs/wasm', f));
}

// the page quotes each example's text size as __SCALE:name__
const index = path.join(site, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/__SCALE:([\w-]+)__/g, (m, name) => {
  if (!scales[name]) throw new Error(`index.html quotes ${m}, but there is no such example`);
  return scales[name];
}));

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
