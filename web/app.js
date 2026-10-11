// The web page: runs core.js on dropped files, entirely in the browser.
import * as pdfjs from 'pdfjs-dist';
import { DEFAULTS, ConcurError, concur } from './core.js';

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
  keepCover: !$('cover').checked,
  oversize: $('oversize').checked ? '1up' : '2up',
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
  // when it was added, so a list left open for a while still makes sense
  const now = new Date();
  const when = el('time', { dateTime: now.toISOString(),
    textContent: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    title: now.toLocaleString() });
  let url = null;
  let removed = false;
  const remove = el('button', { className: 'remove', title: 'Remove', ariaLabel: `Remove ${file.name}`,
    textContent: '×' });
  const row = el('li', { className: 'waiting' },
    el('div', { className: 'head' }, el('div', { className: 'name', textContent: file.name }), when, remove),
    status, actions, details);
  remove.onclick = () => {
    removed = true;
    if (url) URL.revokeObjectURL(url);
    row.remove();
  };
  $('files').prepend(row);

  // `override` changes the options for this file alone, when it is run again
  const run = (override = {}) => enqueue(async () => {
    if (removed) return;
    row.className = 'working';
    status.textContent = 'Trimming margins…';
    actions.replaceChildren();
    const lines = [];
    // let "Working…" paint before the main thread gets busy
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // always make it: a file that comes out small gets a warning, not a refusal
      const { scale, pages, sheets, cover, pdf } = await concur(bytes,
        { ...options(), ...override, force: true }, env, (m) => lines.push(m));
      if (removed) return;   // taken away while it was being worked on
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
      const name = file.name.replace(/\.pdf$/i, '') + '~2up.pdf';
      const small = scale < DEFAULTS.minScale;
      row.className = small ? 'small' : 'ok';
      status.textContent = `Text at ${pct(scale)} of its original size, on ${sheets} `
        + `page${sheets === 1 ? '' : 's'} (was ${pages}).`;
      if (small) {
        status.append(el('div', { className: 'warning', textContent: 'Small print: this one has '
          + 'little margin to trim, and may read better printed normally.' }));
      }
      actions.append(
        el('a', { className: 'button primary', href: url, download: name, textContent: 'Download' }),
        el('a', { className: 'button', href: url, target: '_blank', textContent: 'Open' }),
      );
      // leaving a page out is the one thing here that could surprise someone,
      // so it is said on the file itself, with the way back beside it
      if (cover) {
        status.append(el('div', { className: 'note' },
          `Left out page 1, the ${cover} cover page. `,
          el('button', { className: 'link', textContent: 'Put it back',
            onclick: () => run({ keepCover: true }) })));
      }
    } catch (e) {
      row.className = 'failed';
      status.textContent = e instanceof ConcurError
        ? `Couldn't process this file: ${e.message}.`
        : `Something went wrong: ${e.message}`;
      if (!(e instanceof ConcurError)) console.error(e);
    }
    // the report is written for the command line; drop its hints about flags
    log.textContent = lines.map((l) => l.replace(/ \((--[^)]*)\)|; --[^)]*(?=\))/g, '')).join('\n');
    details.hidden = !lines.length;
  });
  run();
}

const drop = $('drop');
const prompt = drop.querySelector('strong');
const promptText = prompt.textContent;
let gotTimer;

const addAll = (files) => {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  pdfs.forEach(add);
  // say so on the box itself, where the eye already is
  drop.classList.add('got');
  prompt.textContent = pdfs.length
    ? `Got ${pdfs.length === 1 ? 'it' : `${pdfs.length} PDFs`} — working below`
    : 'That wasn’t a PDF';
  clearTimeout(gotTimer);
  gotTimer = setTimeout(() => { drop.classList.remove('got'); prompt.textContent = promptText; }, 2000);
  if (pdfs.length) $('files').firstElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

$('pick').addEventListener('change', (e) => { addAll(e.target.files); e.target.value = ''; });

// accept a drop anywhere on the page, not just on the box
addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addAll(e.dataTransfer.files);
});

// The service worker keeps a copy of the whole site, so the page goes on
// working with no connection at all - which is also the plainest proof that
// nothing is being sent anywhere.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
