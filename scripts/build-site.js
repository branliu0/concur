// Assembles the web page into _site/: the page itself, core.js, and the two
// libraries it imports, copied out of node_modules.  No bundler - the page
// loads them as ES modules through the import map in index.html.
//
//   npm run site && npx serve _site
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// stop GitHub Pages running the site through Jekyll
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log(`built ${path.relative(root, site)}/`);
