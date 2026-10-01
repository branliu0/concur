#!/usr/bin/env node
// concur brief.pdf   ->   brief~2up.pdf, next to the original
//
// The report goes to stderr and the output path to stdout; the exit status is
// 1 when a file is skipped or fails.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, ConcurError, concur } from './core.js';
import { env } from './node-env.js';

const USAGE = `usage: concur [options] input.pdf [output.pdf]

Print a PDF 2-up with margins trimmed.

  -p, --preset NAME    auto (measure; default), booklet, full, or none
      --trim "L B R T" content margins in pt, overriding the measurement;
                       eight numbers set odd pages, then even
      --keep-edges     count download stamps as content instead of ignoring them
      --keep-cover     keep the cover page JSTOR and HeinOnline put in front
  -m, --margin PT      whitespace to keep around the content (default 10)
  -s, --scale F        fraction of the sheet to use (default 0.90)
      --gutter PT      gap between the two pages (default 36)
      --paper NAME     letter, legal or a4 (default letter)
      --oversize MODE  1up (default) gives pages with a much wider block of
                       text a sheet of their own; 2up shrinks them in
      --frame          draw a box around each page
  -f, --force          2-up even if the text would shrink a lot
      --min-scale F    skip unless text stays at least this size (default 0.85)
  -n, --dry-run        measure and report, but write nothing
      --sample N       pages to measure (default 40)
      --pct P          outlier trim percentile; 0 never clips (default 5)
      --dpi N          resolution to measure at (default 50)
  -h, --help`;

const die = (msg) => { console.error(`concur: ${msg}`); process.exit(1); };

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      preset: { type: 'string', short: 'p' },
      margin: { type: 'string', short: 'm' },
      scale: { type: 'string', short: 's' },
      paper: { type: 'string' },
      gutter: { type: 'string' },
      frame: { type: 'boolean' },
      'dry-run': { type: 'boolean', short: 'n' },
      force: { type: 'boolean', short: 'f' },
      'min-scale': { type: 'string' },
      sample: { type: 'string' },
      pct: { type: 'string' },
      dpi: { type: 'string' },
      oversize: { type: 'string' },
      'keep-edges': { type: 'boolean' },
      'keep-cover': { type: 'boolean' },
      trim: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  die(`${e.message}\n\n${USAGE}`);
}
const { values: v, positionals } = args;
if (v.help) { console.log(USAGE); process.exit(0); }
if (positionals.length < 1 || positionals.length > 2) die(`expected one input file\n\n${USAGE}`);

const num = (name, fallback) => {
  if (v[name] === undefined) return fallback;
  const x = Number(v[name]);
  if (Number.isNaN(x)) die(`--${name} wants a number, not "${v[name]}"`);
  return x;
};
if (v.oversize && !['1up', '2up'].includes(v.oversize)) die('--oversize wants 1up or 2up');

const options = {
  preset: v.preset ?? DEFAULTS.preset,
  margin: num('margin', DEFAULTS.margin),
  scale: num('scale', DEFAULTS.scale),
  paper: v.paper ?? DEFAULTS.paper,
  gutter: num('gutter', DEFAULTS.gutter),
  frame: !!v.frame,
  dryRun: !!v['dry-run'],
  force: !!v.force,
  minScale: num('min-scale', DEFAULTS.minScale),
  sample: num('sample', DEFAULTS.sample),
  pct: num('pct', DEFAULTS.pct),
  dpi: num('dpi', DEFAULTS.dpi),
  oversize: v.oversize ?? DEFAULTS.oversize,
  keepEdges: !!v['keep-edges'],
  keepCover: !!v['keep-cover'],
  trim: v.trim ?? null,
};

const src = positionals[0];
const { dir, name } = path.parse(src);
const out = positionals[1] ?? path.join(dir, `${name}~2up.pdf`);

let bytes;
try {
  bytes = new Uint8Array(fs.readFileSync(src));
} catch (e) {
  die(e.code === 'ENOENT' ? `no such file: ${src}` : `could not read ${src} (${e.message})`);
}

try {
  const { pdf } = await concur(bytes, options, env, (m) => console.error(`concur: ${m}`));
  if (pdf) {
    try {
      fs.writeFileSync(out, pdf);
    } catch (e) {
      die(`could not write ${out} (${e.message})`);
    }
    console.log(out);
  }
} catch (e) {
  if (!(e instanceof ConcurError)) throw e;
  die(e.skipped ? e.message : `${src}: ${e.message}`);
}
// pdf.js keeps a worker alive that would otherwise hold the process open
process.exit(0);
