// The web page: runs core.js on dropped files, entirely in the browser.
import * as pdfjs from 'pdfjs-dist';
import { Pdf2pageError, pdf2page } from './core.js';

const vendor = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = vendor + 'pdf.worker.min.mjs';

const env = {
  openPdfjs: (data) => pdfjs.getDocument({
    data,
    standardFontDataUrl: vendor + 'standard_fonts/',
    cMapUrl: vendor + 'cmaps/',
    cMapPacked: true,
    wasmUrl: vendor + 'wasm/',
    iccUrl: vendor + 'iccs/',
    verbosity: 0,
  }).promise,
  createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const pct = (x) => `${Math.round(x * 100)}%`;

const options = () => ({
  paper: $('paper').value,
  keepEdges: !$('stamps').checked,
  oversize: $('oversize').checked ? '1up' : '2up',
  frame: $('frame').checked,
});

// One file at a time: each takes a second or two of the main thread, and a
// queue keeps the rows updating in order.
let queue = Promise.resolve();
const enqueue = (job) => { queue = queue.then(job, job); };

function add(file) {
  const status = el('div', { className: 'status', textContent: 'Waiting…' });
  const actions = el('div', { className: 'actions' });
  const log = el('pre');
  const details = el('details', { hidden: true }, el('summary', { textContent: 'Details' }), log);
  const row = el('li', {}, el('div', { className: 'name', textContent: file.name }),
    status, actions, details);
  $('files').prepend(row);

  const run = (force) => enqueue(async () => {
    row.className = '';
    status.textContent = 'Working…';
    actions.replaceChildren();
    const lines = [];
    // let "Working…" paint before the main thread gets busy
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { scale, sheets, pdf } = await pdf2page(bytes, { ...options(), force }, env,
        (m) => lines.push(m));
      const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
      const name = file.name.replace(/\.pdf$/i, '') + '~2up.pdf';
      row.className = 'ok';
      status.textContent = `Text at ${pct(scale)} of its original size, on ${sheets} `
        + `sheet${sheets === 1 ? '' : 's'}.`;
      actions.append(
        el('a', { className: 'button primary', href: url, download: name, textContent: 'Download' }),
        el('a', { className: 'button', href: url, target: '_blank', textContent: 'Open' }),
      );
    } catch (e) {
      if (e instanceof Pdf2pageError && e.skipped) {
        row.className = 'skipped';
        status.textContent = `Not worth it: the text would shrink to ${pct(e.scale)}. `
          + 'This one will read better printed normally.';
        actions.append(el('button', { textContent: 'Make it anyway', onclick: () => run(true) }));
      } else {
        row.className = 'failed';
        status.textContent = e instanceof Pdf2pageError
          ? `Couldn't process this file: ${e.message}.`
          : `Something went wrong: ${e.message}`;
        if (!(e instanceof Pdf2pageError)) console.error(e);
      }
    }
    // the report is written for the command line; drop its hints about flags
    log.textContent = lines.map((l) => l.replace(/ \((--[^)]*)\)|; --[^)]*(?=\))/g, '')).join('\n');
    details.hidden = !lines.length;
  });
  run(false);
}

const addAll = (files) => {
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) add(f);
  }
};

$('pick').addEventListener('change', (e) => { addAll(e.target.files); e.target.value = ''; });

const drop = $('drop');
// accept a drop anywhere on the page, not just on the box
addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addAll(e.dataTransfer.files);
});
