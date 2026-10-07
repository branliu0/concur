// concur - print a PDF 2-up, trimming dead margins so the text stays readable.
//
// This is the whole of the logic, and it runs unchanged in Node and in a
// browser: bytes in, bytes out.  The two things that differ between them - how
// pdf.js is loaded and where a canvas comes from - are handed in as `env`.
//
// See README.md for what it decides and why.
import {
  PDFArray, PDFContentStream, PDFDocument, PDFName, PDFObjectCopier,
  PDFRawStream, PDFStream, decodePDFRawStream,
} from '@cantoo/pdf-lib';

const SIZE_TOL = 8.0;         // pt; scans wander a point or two between pages

export const PAPER = {        // landscape sheet, w x h in points
  letter: [792.0, 612.0],
  legal: [1008.0, 612.0],
  a4: [841.89, 595.28],
};

export const DEFAULTS = {
  noTrim: false, margin: 10.0, scale: 0.90, paper: 'letter', gutter: 36.0,
  frame: false, dryRun: false, force: false, minScale: 0.85, sample: 40,
  pct: 5.0, dpi: 50, oversize: '1up', keepEdges: false, keepCover: false, trim: null,
};

// Lines a publisher stamps on every page.  Matched against the extracted text,
// which is the only thing that tells a stamp apart from a footnote when the two
// are the same shape and size - JSTOR's sits centred under the text block,
// exactly where a footnote would.  Matched with all whitespace removed, since
// pdf.js hands text over in runs that can break anywhere, mid-word included.
const STAMPS = new RegExp([
  'this content downloaded',                    // JSTOR
  'all use subject to',
  'jstor terms and conditions',
  'downloaded from ht', 'downloaded from (www\\.|academic\\.)',  // OUP, Cambridge
  'subject to the cambridge core',
  'content downloaded/printed from',            // HeinOnline
  'heinonline',
  'electronic copy available at',               // SSRN
  'terms of use,? available at',
].map((s) => s.replace(/ /g, '')).join('|'), 'i');

// A date or a time of day: 5/6/2019, 2019-05-06, May 6, 2019, 11:50 AM,
// 17:32:51.  Matched against text with its spacing kept, since run together a
// date and a time are just one long number.
const DATE = new RegExp([
  '(?<!\\d)\\d{1,2}/\\d{1,2}/\\d{2,4}(?!\\d)',
  '(?<!\\d)\\d{4}-\\d{2}-\\d{2}(?!\\d)',
  '\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*\\d{1,2},\\s*\\d{4}',
  '(?<!\\d)\\d{1,2}:\\d{2}(:\\d{2})?\\s*[ap]\\.?m\\b',
  '(?<![\\d:])\\d{1,2}:\\d{2}:\\d{2}(?![\\d:])',
].join('|'), 'i');

// What the page a publisher puts in front of a download says about itself.
// Matched, like STAMPS, with whitespace removed, and only against page 1.
const COVERS = [
  ['JSTOR', /youruseofthejstorarchiveindicates|jstorisanot-for-profit|earlyjournalcontentonjstor/i],
  ['HeinOnline', /youruseofthisheinonlinepdfindicates|contentdownloadedfromheinonline/i],
];

// A file that was read fine but is not worth 2-upping (`skipped`), or one that
// could not be processed at all.
export class ConcurError extends Error {
  constructor(message, { skipped = false, scale = null } = {}) {
    super(message);
    this.skipped = skipped;
    this.scale = scale;       // what the text would have shrunk to, when skipped
  }
}

// Python's round(): halves go to the even neighbour.  Kept so the numbers
// reported match the original implementation's exactly.
function round(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function median(vals) {
  const v = [...vals].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const fmt = (t) => `L${round(t[0])} B${round(t[1])} R${round(t[2])} T${round(t[3])}`;
const pct = (x) => `${round(x * 100)}%`;
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

// Where each page's download stamps sit: Map(page -> [[x0, y0, x1, y1]]), in
// points from the top left, and the slug line if there is one (see below).
//
// pdf.js gives every run of text its position; runs sharing a baseline are
// joined back into a line, and a block of lines whose text matches STAMPS is a
// stamp.  Reading the words is what makes this reliable - geometry alone
// cannot separate JSTOR's centred footer from the footnotes right above it.
async function stampBoxes(doc, sample) {
  const out = new Map();
  const upright = [];      // every upright line: { n, key, d0, box }
  let withText = 0;
  for (let n = 1; n <= Math.min(sample, doc.numPages); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    // Runs are sorted into lines along the direction they read in, so OUP's
    // stamp running up the side of the page is a line like any other: `r` runs
    // along the text and `d` down the page as its reader sees it.
    const byDir = [[], [], [], []];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = mul(vp.transform, it.transform);
      const len = Math.hypot(t[0], t[1]);
      if (!len || !Math.hypot(t[2], t[3])) continue;
      const st = tc.styles[it.fontName] || {};
      const asc = Number.isFinite(st.ascent) && st.ascent ? st.ascent : 0.9;
      const desc = Number.isFinite(st.descent) && st.descent ? st.descent : -0.2;
      const k = ((Math.round(Math.atan2(t[1], t[0]) / (Math.PI / 2)) % 4) + 4) % 4;
      const [ux, uy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
      const w = { r0: Infinity, r1: -Infinity, d0: Infinity, d1: -Infinity, str: it.str };
      for (const s of [0, it.width]) {
        for (const h of [desc, asc]) {
          const x = t[4] + (t[0] / len) * s + t[2] * h;
          const y = t[5] + (t[1] / len) * s + t[3] * h;
          const r = x * ux + y * uy, d = -x * uy + y * ux;
          w.r0 = Math.min(w.r0, r); w.r1 = Math.max(w.r1, r);
          w.d0 = Math.min(w.d0, d); w.d1 = Math.max(w.d1, d);
        }
      }
      byDir[k].push(w);
    }
    if (byDir.some((d) => d.length)) withText++;
    for (const [k, words] of byDir.entries()) {
      if (!words.length) continue;
      const [ux, uy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
      words.sort((a, b) => round(a.d0) - round(b.d0) || a.r0 - b.r0);
      const lines = [];
      for (const w of words) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last[0].d0 - w.d0) <= 2.0) last.push(w);
        else lines.push([w]);
      }
      // a stamp runs to two or three lines and only one of them carries the
      // give-away words: JSTOR's middle line is a bare IP address and date,
      // so a matched line takes the block it sits in with it
      const blocks = [];
      for (const line of lines) {
        const box = {
          r0: Math.min(...line.map((w) => w.r0)), r1: Math.max(...line.map((w) => w.r1)),
          d0: Math.min(...line.map((w) => w.d0)), d1: Math.max(...line.map((w) => w.d1)),
          text: line.map((w) => w.str).join(''),
        };
        if (k === 0) {
          // with spaces put back where the runs leave a gap, for showing it
          const shown = line.map((w, i) => (i && w.r0 - line[i - 1].r1 > 1 ? ' ' : '') + w.str)
            .join('').replace(/\s+/g, ' ').trim();
          upright.push({ n, key: box.text.replace(/\s+/g, ''), shown, d0: box.d0,
            box: [box.r0, box.d0, box.r1, box.d1] });
        }
        const last = blocks[blocks.length - 1];
        if (last && box.d0 - last.d1 < 6.0) {
          last.r0 = Math.min(last.r0, box.r0); last.r1 = Math.max(last.r1, box.r1);
          last.d1 = box.d1; last.text += box.text;
        } else {
          blocks.push(box);
        }
      }
      for (const b of blocks) {
        if (!STAMPS.test(b.text.replace(/\s+/g, ''))) continue;
        // back from the reader's frame to the page's
        const xs = [b.r0 * ux - b.d0 * uy, b.r1 * ux - b.d1 * uy];
        const ys = [b.r0 * uy + b.d0 * ux, b.r1 * uy + b.d1 * ux];
        if (!out.has(n)) out.set(n, []);
        out.get(n).push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
    page.cleanup();
  }

  // A slug: the line a typesetting template prints on every page for the
  // people producing the journal - a file name and the date it was last
  // saved ("Sprigman_Final_Review (Do Not Delete) 5/6/2019 11:50 AM").  What
  // gives it away is not its wording, which varies, but a date that stays the
  // same in the same place on every page: no running head does that, since a
  // running head that never changes carries no date.
  let slug = null;
  const seen = new Map();
  for (const l of upright) {
    if (!DATE.test(l.shown)) continue;
    // a line of a download stamp - JSTOR's carries the date it was downloaded
    const inStamp = (out.get(l.n) || []).some(([x0, y0, x1, y1]) => l.box[0] >= x0 - 1
      && l.box[1] >= y0 - 1 && l.box[2] <= x1 + 1 && l.box[3] <= y1 + 1);
    if (inStamp) continue;
    if (!seen.has(l.key)) seen.set(l.key, []);
    seen.get(l.key).push(l);
  }
  for (const [key, ls] of seen) {
    const pages = new Set(ls.map((l) => l.n));
    const ds = ls.map((l) => l.d0);
    if (pages.size < Math.max(3, Math.ceil(0.9 * withText))) continue;
    if (Math.max(...ds) - Math.min(...ds) > 3) continue;
    slug = { text: ls[0].shown, boxes: new Map() };
    for (const l of ls) slug.boxes.set(l.n, l.box);
    break;
  }
  return { stamps: out, slug };
}

// Whose cover page page 1 is ("JSTOR", "HeinOnline"), or null if it is not one.
async function coverPage(doc) {
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((it) => it.str).join('').replace(/\s+/g, '');
  page.cleanup();
  const hit = COVERS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

// --- a page's ink, as a pw x ph grid of 0/1 ---------------------------------

const anyInk = (ink) => ink.data.includes(1);

// Which columns (or rows) have any ink, optionally looking only at rows
// r0..r1, or at everything but those rows.
function colAny(ink, r0 = 0, r1 = ink.ph - 1, except = false) {
  const m = new Uint8Array(ink.pw);
  for (let y = 0; y < ink.ph; y++) {
    if ((y >= r0 && y <= r1) === except) continue;
    for (let x = 0, o = y * ink.pw; x < ink.pw; x++) if (ink.data[o + x]) m[x] = 1;
  }
  return m;
}

function rowAny(ink) {
  const m = new Uint8Array(ink.ph);
  for (let y = 0; y < ink.ph; y++) {
    if (ink.data.subarray(y * ink.pw, (y + 1) * ink.pw).includes(1)) m[y] = 1;
  }
  return m;
}

function blank(ink, x0, y0, x1, y1) {   // inclusive
  for (let y = Math.max(0, y0); y <= Math.min(ink.ph - 1, y1); y++) {
    ink.data.fill(0, y * ink.pw + Math.max(0, x0), y * ink.pw + Math.min(ink.pw - 1, x1) + 1);
  }
}

// Runs of consecutive set values, as [start, end] index pairs.
function runsOf(mask) {
  const runs = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs;
}

// Join runs closer together than minGap pt: a stamp is a few lines of text,
// and the leading between them is much smaller than the margin of whitespace
// that separates the stamp as a whole from the page's content.
function mergeRuns(runs, pt, minGap) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && (r[0] - last[1] - 1) * pt < minGap) last[1] = r[1];
    else out.push([...r]);
  }
  return out;
}

// Whether rows r0..r1 hold nothing but horizontal rules: every row with ink in
// it is solid from one end to the other, and at least a quarter of the page
// wide.  A rule has nothing to read in it, so unlike a running head it can go
// whatever its width - such as the empty box a law review template draws
// above the running head on every page.
function onlyRules(ink, r0, r1) {
  let any = false;
  for (let y = r0; y <= r1; y++) {
    const row = ink.data.subarray(y * ink.pw, (y + 1) * ink.pw);
    const first = row.indexOf(1);
    if (first < 0) continue;
    const last = row.lastIndexOf(1);
    let filled = 0;
    for (let x = first; x <= last; x++) filled += row[x];
    if (last - first + 1 < ink.pw / 4 || filled < 0.9 * (last - first + 1)) return false;
    any = true;
  }
  return any;
}

// Blank out a download stamp standing in the margin, if there is one.
//
// Publishers stamp every page: OUP runs a line of rotated text down the side
// ("Downloaded from academic.oup.com ..."), Cambridge Core a couple of lines
// across the foot of the page.  It is real ink, so the bounding box swallows
// it and that margin measures as nearly zero.
//
// Down the side, a stamp is a strip at most maxW pt wide standing at least
// minGap pt clear of everything else.  Across the top or bottom the same
// shape describes a running head or a page number, which must not be clipped,
// so a band there also has to be wider than the text block it sits under - by
// widerBy pt - which a stamp reaching toward the page edges is and a centred
// folio is not - unless it is nothing but rules (see onlyRules).  Edits ink in
// place; returns the number of stamps removed.
function stripStamps(ink, W, H, maxW = 14.0, maxH = 26.0, minGap = 6.0, widerBy = 12.0) {
  let removed = 0;
  for (let pass = 0; pass < 4; pass++) {   // a stamp can run to two or three lines
    let gone = false;
    // down the sides first (a column profile), then top and bottom (rows)
    for (const vertical of [true, false]) {
      const pt = vertical ? W / ink.pw : H / ink.ph;
      const limit = vertical ? maxW : maxH;
      const runs = mergeRuns(runsOf(vertical ? colAny(ink) : rowAny(ink)), pt, minGap);
      for (const first of [true, false]) {
        if (runs.length < 2) continue;
        const [a, b] = first ? runs[0] : runs[runs.length - 1];
        const nb = first ? runs[1] : runs[runs.length - 2];
        const gap = first ? nb[0] - b - 1 : a - nb[1] - 1;
        if ((b - a + 1) * pt > limit || gap * pt < minGap) continue;
        if (!vertical && !onlyRules(ink, a, b)) {
          // the band against the ink that remains without it
          const bx = runsOf(colAny(ink, a, b)), rx = runsOf(colAny(ink, a, b, true));
          if (!bx.length || !rx.length) continue;
          const span = (bx[bx.length - 1][1] - bx[0][0]) - (rx[rx.length - 1][1] - rx[0][0]);
          if (span * (W / ink.pw) < widerBy) continue;
        }
        if (vertical) blank(ink, a, 0, b, ink.ph - 1);
        else blank(ink, 0, a, ink.pw - 1, b);
        removed++;
        gone = true;
        break;
      }
      if (gone) break;
    }
    if (!gone || !anyInk(ink)) break;
  }
  if (!anyInk(ink)) return removed;
  // an otherwise blank page: a lone strip hugging a side edge is still a stamp
  const runs = mergeRuns(runsOf(colAny(ink)), W / ink.pw, minGap);
  if (runs.length === 1) {
    const [a, b] = runs[0];
    if ((b - a + 1) * (W / ink.pw) <= maxW && (b < ink.pw * 0.1 || a > ink.pw * 0.9)) {
      blank(ink, a, 0, b, ink.ph - 1);
      removed++;
    }
  }
  return removed;
}

// Content margins from per-page ink extents, in points.
//
// Returns Map(page number -> [L, B, R, T]) for every page with ink on it, or
// null when nothing could be measured.  sizes[i] is page i+1's [w, h]; `only`
// limits the measurement to those page numbers.
//
// Renders each page at a low dpi and takes the bounding box of everything
// darker than near-white.  The low dpi is doing real work: a scan carries
// speckle along the page edges, and at 600dpi a stray dot is ink that a
// bounding box must enclose - which is why measuring a scan at full resolution
// reports margins of zero.  Downsampled to ~50dpi with antialiasing, an
// isolated dot averages away to white while text strokes stay dark, so the box
// lands on the actual text block.  It is also far faster than rendering the
// full-resolution bitmap.
//
// See aggregate() for how the per-page boxes become one box per parity.
async function measure(doc, env, sizes, { sample, dpi, stripEdges, only, stamps, slug, marks, log }) {
  const boxes = new Map();
  let stamped = 0, pages = 0, found = 0;
  for (let n = 1; n <= Math.min(sample, doc.numPages); n++) {
    if (!only.has(n)) continue;
    const [W, H] = sizes[n - 1];
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const pw = Math.ceil(viewport.width), ph = Math.ceil(viewport.height);
    const canvas = env.createCanvas(pw, ph);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pw, ph);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const px = ctx.getImageData(0, 0, pw, ph).data;
    page.cleanup();
    const ink = { data: new Uint8Array(pw * ph), pw, ph };
    for (let i = 0, o = 0; i < ink.data.length; i++, o += 4) {
      ink.data[i] = (px[o] * 77 + px[o + 1] * 151 + px[o + 2] * 28) >> 8 < 200 ? 1 : 0;
    }
    if (!anyInk(ink)) continue;
    pages++;
    if (marks[n - 1]) {
      // everything outside the trim box is printer's marks
      const [l, b, r, t] = marks[n - 1];
      const x0 = Math.ceil(l / W * pw), x1 = pw - Math.ceil(r / W * pw);
      const y0 = Math.ceil(t / H * ph), y1 = ph - Math.ceil(b / H * ph);
      blank(ink, 0, 0, x0 - 1, ph - 1); blank(ink, x1, 0, pw - 1, ph - 1);
      blank(ink, 0, 0, pw - 1, y0 - 1); blank(ink, 0, y1, pw - 1, ph - 1);
      if (!anyInk(ink)) continue;
    }
    const boxesHere = stamps.get(n) || [];
    if (boxesHere.length) found++;
    const slugHere = slug?.boxes.get(n);
    for (const [x0, y0, x1, y1] of slugHere ? [...boxesHere, slugHere] : boxesHere) {
      // blank the stamp where the text says it is, with a little slack for the
      // ink that antialiasing spreads past the glyph box
      blank(ink, Math.floor((x0 - 1) / W * pw), Math.floor((y0 - 1) / H * ph),
        Math.floor((x1 + 1) / W * pw), Math.floor((y1 + 1) / H * ph));
    }
    // A speck of dust on the platen is one dark pixel in a row that a line of
    // text fills fifty of, but a bounding box has to enclose it all the same -
    // and a single speck near the edge of the sheet swallows that whole margin.
    // Rows and columns carrying less than ~1% of their length in ink are
    // dropped as noise.
    const minRow = Math.max(2, round(0.01 * pw)), minCol = Math.max(2, round(0.01 * ph));
    for (let y = 0; y < ph; y++) {
      let s = 0;
      for (let x = 0; x < pw; x++) s += ink.data[y * pw + x];
      if (s < minRow) ink.data.fill(0, y * pw, (y + 1) * pw);
    }
    for (let x = 0; x < pw; x++) {
      let s = 0;
      for (let y = 0; y < ph; y++) s += ink.data[y * pw + x];
      if (s < minCol) for (let y = 0; y < ph; y++) ink.data[y * pw + x] = 0;
    }
    if (!anyInk(ink)) continue;
    if (stripEdges) {
      if (stripStamps(ink, W, H) > 0) stamped++;
      if (!anyInk(ink)) continue;
    }
    const xs = runsOf(colAny(ink)), ys = runsOf(rowAny(ink));
    const xMin = xs[0][0], xMax = xs[xs.length - 1][1];
    const yMin = ys[0][0], yMax = ys[ys.length - 1][1];
    // back to points via the page's own pixel dims, not the dpi ratio, so
    // rounding the canvas up to whole pixels cannot shift the box
    // L, B, R, T - canvas rows run top-down, so yMin is the top margin
    boxes.set(n, [xMin / pw * W, (ph - 1 - yMax) / ph * H,
      (pw - 1 - xMax) / pw * W, yMin / ph * H]);
  }
  if (found || stamped) {
    const how = [];
    if (found) how.push(`${found} named in the text`);
    if (stamped) how.push(`${stamped} by shape`);
    log(`ignored download stamps on ${Math.max(found, stamped)} of ${pages} pages `
      + `(${how.join(', ')}; --keep-edges to count them)`);
  }
  return boxes.size ? boxes : null;
}

// One content box per parity: {1: odd pages, 0: even pages}.
//
// Scanned books place the text block differently on recto and verso pages, so
// the two are kept apart; covering both with one box would waste the offset
// between them as width.
//
// pct trims outliers (default 5th/95th percentile) so one odd page cannot
// force a huge margin.  pct=0 uses the true min/max, which guarantees nothing
// is ever clipped - use it when a single page carries extra content such as a
// stamped header, which a percentile would discard as an outlier.
function aggregate(boxes, pct) {
  const sides = { 0: [], 1: [] };
  for (const [n, b] of boxes) sides[n % 2].push(b);
  // a parity with nothing measured (a one-page document) borrows the other's
  for (const p of [0, 1]) if (!sides[p].length) sides[p] = sides[1 - p];
  const q = (vals) => {
    vals.sort((a, b) => a - b);
    return vals[Math.max(0, Math.min(vals.length - 1, round(pct / 100 * (vals.length - 1))))];
  };
  const out = {};
  for (const p of [0, 1]) out[p] = [0, 1, 2, 3].map((k) => q(sides[p].map((b) => b[k])));
  return out;
}

const plural = (n, one, many) => (n > 1 ? many : one);

function decodeContents(contents) {
  if (!contents) return new Uint8Array(0);
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFStream))
    : [contents];
  const parts = [];
  for (const s of streams) {
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode());
    else if (s instanceof PDFContentStream) parts.push(s.getUnencodedContents());
    else throw new ConcurError('a page has contents of a kind that cannot be read');
    parts.push(Uint8Array.of(10));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// How far inside the page its trim box sits, as displayed: [L, B, R, T] in
// points, or null when the page has no margin of that kind.
//
// A proof straight from the typesetter is a sheet bigger than the book's page,
// with crop marks, registration targets and a slug line ("UNCORRECTED PROOF",
// the file name, the date) in the extra.  That is ink right out at the edges,
// so the page measures as having no margin at all - but the file says where
// the real page ends: that is what /TrimBox is for.
function printersMarks(page) {
  const c = page.getCropBox(), t = page.getTrimBox();
  // [L, B, R, T] in the page's own frame, then turned to match /Rotate
  const own = [t.x - c.x, t.y - c.y, c.x + c.width - (t.x + t.width), c.y + c.height - (t.y + t.height)];
  if (own.some((v) => v < -0.5) || own.every((v) => v < 1)) return null;
  // a trim box that leaves less than half the page is more likely a mistake
  if (t.width < c.width / 2 || t.height < c.height / 2) return null;
  const [l, b, r, tp] = own.map((v) => Math.max(0, v));
  return {
    0: [l, b, r, tp], 90: [b, r, tp, l], 180: [r, tp, l, b], 270: [tp, l, b, r],
  }[((page.getRotation().angle % 360) + 360) % 360];
}

// The page, untouched, as a Form XObject in displayed orientation.
//
// Wrapping the page's content stream as-is is what LaTeX's pdfpages does: the
// content is never parsed, so a text-heavy page copies over in milliseconds.
// /Matrix maps the page's own space to its displayed frame (lower left at
// 0,0), which folds any /Rotate in without touching the content either.
function formXObject(out, copier, page) {
  const { x: X0, y: Y0, width, height } = page.getCropBox();
  const X1 = X0 + width, Y1 = Y0 + height;
  const matrix = {
    0: [1, 0, 0, 1, -X0, -Y0],
    90: [0, -1, 1, 0, -Y0, X1],
    180: [-1, 0, 0, -1, X1, Y1],
    270: [0, 1, -1, 0, Y1, -X0],
  }[((page.getRotation().angle % 360) + 360) % 360];
  const dict = {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [X0, Y0, X1, Y1], Matrix: matrix,
  };
  const resources = page.node.Resources();
  if (resources) dict.Resources = copier.copy(resources);
  const group = page.node.lookup(PDFName.of('Group'));   // keep transparency groups rendering right
  if (group) dict.Group = copier.copy(group);
  const stream = out.context.flateStream(decodeContents(page.node.Contents()), dict);
  return out.context.register(stream);
}

// 2-up the PDF in `bytes` (a Uint8Array).
//
// env.openPdfjs(bytes) returns a pdf.js document and env.createCanvas(w, h) a
// canvas, for reading the text and measuring the margins.  log(message)
// receives each line of the report.
//
// Returns { scale, pages, sheets, cover, pdf }: the source's page count, the
// number of sheets they went onto, whose cover page was left out (or null),
// and the new file's bytes (null on a dry run).  Throws ConcurError - with
// .skipped set when the file is fine but would shrink below minScale.
export async function concur(bytes, options = {}, env = {}, log = () => {}) {
  let doc = null;
  // pdf.js takes ownership of the buffer it is given, so it gets a copy
  const pdfjsDoc = async () => (doc ??= await env.openPdfjs(bytes.slice()));
  try {
    return await run(bytes, { ...DEFAULTS, ...options }, pdfjsDoc, env, log);
  } finally {
    if (doc) await doc.loadingTask.destroy();
  }
}

async function run(bytes, a, pdfjsDoc, env, log) {
  const paper = String(a.paper).toLowerCase().replace(/paper$/, '');
  if (!PAPER[paper]) {
    throw new ConcurError(`unknown --paper ${a.paper}; choose from ${Object.keys(PAPER).join(', ')}`);
  }
  const [SW, SH] = PAPER[paper];

  let src, pages, sizes, marks;
  try {
    src = await PDFDocument.load(bytes, { password: '' });
    pages = src.getPages();
    // page sizes as displayed, i.e. after /Rotate - which is how pdf.js
    // renders them and so the frame the measured margins are in
    sizes = pages.map((pg) => {
      const { width, height } = pg.getCropBox();
      return pg.getRotation().angle % 180 === 0 ? [width, height] : [height, width];
    });
    marks = pages.map(printersMarks);
  } catch (e) {
    throw new ConcurError(`could not read it as a PDF (${e.message})`);
  }
  if (!pages.length) throw new ConcurError('it has no pages');

  // A JSTOR or HeinOnline download leads with a page about the download
  // itself: the citation, the terms of use.  Nobody prints an article to read
  // that, and it knocks the pairing off by one, so it is left out.
  let cover = null;
  if (!a.keepCover && pages.length > 1) {
    try {
      cover = await coverPage(await pdfjsDoc());
    } catch {
      // unreadable text just means no cover page was recognised
    }
    if (cover) log(`page 1 is a ${cover} cover page; leaving it out (--keep-cover to keep it)`);
  }
  const kept = pages.map((_, i) => i).filter((i) => !(cover && i === 0));

  // A page of a different size from the rest - a cover page that was kept or
  // not recognised, a fold-out - is often nearly full of text.  Measured in
  // with the rest it wrecks the margins, and sized in with the rest it shrinks
  // the whole document to fit itself, so pages of any less common size are set
  // aside: placed untrimmed, scaled only if they would overflow, and left out
  // of both calculations.
  const usual = [median(kept.map((i) => sizes[i][0])), median(kept.map((i) => sizes[i][1]))];
  const regularSize = (wh) => Math.abs(wh[0] - usual[0]) <= SIZE_TOL
    && Math.abs(wh[1] - usual[1]) <= SIZE_TOL;
  const regular = [], oddSized = [];
  kept.forEach((i) => (regularSize(sizes[i]) ? regular : oddSized).push(i));
  if (oddSized.length) {
    const n = oddSized.length;
    const shown = oddSized.slice(0, 4).map((i) => i + 1).join(', ');
    const more = n > 4 ? ` and ${n - 4} more` : '';
    log(`page${plural(n, '', 's')} ${shown}${more} ${plural(n, 'is', 'are')} not `
      + `${round(usual[0])}x${round(usual[1])}pt (a cover page?); placing untrimmed`);
  }

  // content margins per parity: {1: odd pages, 0: even pages}
  let raw = new Map();          // per-page boxes
  let stamps = new Map(), slug = null;
  let oneUp = new Set();        // pages (0-based) to print one to a sheet
  let marg;
  if (a.trim) {
    const v = (Array.isArray(a.trim) ? a.trim : String(a.trim).replace(/,/g, ' ').trim().split(/\s+/))
      .map(Number);
    if (![4, 8].includes(v.length) || v.some(Number.isNaN)) {
      throw new ConcurError('--trim wants four numbers "L B R T" in points, '
        + 'or eight (odd pages, then even)');
    }
    marg = { 1: v.slice(0, 4), 0: v.length === 8 ? v.slice(4) : v.slice(0, 4) };
  } else if (a.noTrim) {
    marg = { 1: [0, 0, 0, 0], 0: [0, 0, 0, 0] };
  } else {
    let measured = null;
    try {
      const doc = await pdfjsDoc();
      ({ stamps, slug } = a.keepEdges ? { stamps: new Map(), slug: null }
        : await stampBoxes(doc, a.sample));
      if (slug) {
        log(`"${slug.text}" is on every page; keeping it on the first only`);
      }
      if (!a.keepEdges && regular.some((i) => marks[i])) {
        log("ignoring the printer's marks outside the trim box (--keep-edges to count them)");
      }
      measured = await measure(doc, env, sizes, {
        sample: a.sample, dpi: a.dpi, stripEdges: !a.keepEdges,
        only: new Set(regular.map((i) => i + 1)), stamps, slug,
        marks: a.keepEdges ? [] : marks, log,
      });
    } catch (e) {
      log(`could not render it to measure (${e.message})`);
    }
    if (!measured) {
      log('could not measure content; falling back to no trim');
      marg = { 1: [0, 0, 0, 0], 0: [0, 0, 0, 0] };
    } else {
      raw = measured;
      // A journal's front matter (Yale Law Journal's abstract and contents,
      // say) sets the text across the full page while the article itself
      // runs in a narrow block.  Two-upping both means sizing everything to
      // the widest, so pages whose block is much bigger than the rest are
      // measured out and printed one to a sheet at full size instead.
      let wide = new Set();
      if (a.oversize === '1up' && raw.size > 2) {
        // width only: a page's measured height wanders with the footnote
        // block, and speckle at the edge of a scan can stretch it by a
        // third of the page, which is not a reason to break the pairing
        const widths = new Map([...raw].map(([n, b]) => [n, sizes[n - 1][0] - b[0] - b[2]]));
        const mw = median(widths.values());
        for (const [n, w] of widths) if (w > mw + Math.max(24.0, 0.1 * mw)) wide.add(n);
        if (wide.size && wide.size < raw.size) {
          const n = wide.size;
          const sorted = [...wide].sort((x, y) => x - y);
          const more = n > 6 ? ` and ${n - 6} more` : '';
          log(`page${plural(n, '', 's')} ${sorted.slice(0, 6).join(', ')}${more} `
            + `hold${plural(n, 's', '')} a wider block of text; `
            + `printing ${plural(n, 'it', 'them')} 1-up `
            + `(--oversize 2up to shrink ${plural(n, 'it', 'them')} in)`);
        } else {
          wide = new Set();
        }
      }
      oneUp = new Set([...wide].map((n) => n - 1));
      marg = aggregate(new Map([...raw].filter(([n]) => !wide.has(n))), a.pct);
    }
  }

  // never trim past the content, and never trim negative
  const pare = (m) => m.map((x) => Math.max(0.0, x - a.margin));
  const trim = { 0: pare(marg[0]), 1: pare(marg[1]) };
  const how = a.trim ? 'manual' : a.noTrim ? 'no' : 'auto';
  if (trim[1].every((x, k) => x === trim[0][k])) log(`${how} trim  ${fmt(trim[1])}`);
  else log(`${how} trim  odd ${fmt(trim[1])}  even ${fmt(trim[0])}`);

  // each page's trimmed box goes in a cell half the usable sheet wide; one
  // scale for the whole document, set by whichever parity fits worse, keeps
  // the type the same size on every page
  const cellW = (SW * a.scale - a.gutter) / 2, cellH = SH * a.scale;
  const box = (i) => {
    // trimmed box in displayed coordinates, origin at the page's lower left
    const [W, H] = sizes[i];
    let t;
    if (!regularSize(sizes[i])) t = [0, 0, 0, 0];
    else if (oneUp.has(i)) t = pare(raw.get(i + 1));   // a 1-up page is trimmed to its own ink
    else t = trim[(i + 1) % 2];
    const b = [t[0], t[1], W - t[2], H - t[3]];
    if (b[2] - b[0] < 1 || b[3] - b[1] < 1) {
      throw new ConcurError(`trim leaves nothing of page ${i + 1}`);
    }
    return b;
  };
  const fit = (b, w = cellW, h = cellH) => Math.min(w / (b[2] - b[0]), h / (b[3] - b[1]));
  // one scale for the document, set by the worse-fitting parity of a regular page
  const paired = regular.filter((i) => !oneUp.has(i));
  const scale = paired.length ? Math.min(...paired.slice(0, 2).map((i) => fit(box(i)))) : 1.0;
  log(`text ends at ~${pct(scale)} of original size`);
  if (scale < a.minScale && !a.force) {
    throw new ConcurError(`skipping - only ${pct(scale)} of original size `
      + `(margins too small to reclaim; threshold ${pct(a.minScale)}). `
      + 'Use --force or lower --min-scale to override.', { skipped: true, scale });
  }
  if (a.dryRun) return { scale, pages: pages.length, sheets: 0, cover, pdf: null };

  // pair the pages up, giving each 1-up page a sheet of its own
  const plan = [];
  let pair = [];
  for (const i of kept) {
    if (oneUp.has(i)) {
      if (pair.length) { plan.push(pair); pair = []; }
      plan.push([i]);
      continue;
    }
    pair.push(i);
    if (pair.length === 2) { plan.push(pair); pair = []; }
  }
  if (pair.length) plan.push(pair);

  const out = await PDFDocument.create();
  const copier = PDFObjectCopier.for(src.context, out.context);
  const f3 = (x) => x.toFixed(3), f5 = (x) => x.toFixed(5);
  for (const group of plan) {
    const solo = group.length === 1 && oneUp.has(group[0]);
    // a 1-up page keeps the source's portrait shape and its own size
    const [sheetW, sheetH] = solo ? [SH, SW] : [SW, SH];
    const [cw, ch] = solo ? [sheetW * a.scale, sheetH * a.scale] : [cellW, cellH];
    const left = (sheetW - (solo ? cw : 2 * cellW + a.gutter)) / 2;
    const bottom = (sheetH - ch) / 2;
    const sheet = out.addPage([sheetW, sheetH]);
    const ops = [], xobjects = {};
    group.forEach((j, slot) => {
      const b = box(j);
      const s = solo ? Math.min(1.0, fit(b, cw, ch)) : Math.min(scale, fit(b));
      const w = (b[2] - b[0]) * s, h = (b[3] - b[1]) * s;
      const ox = left + slot * (cellW + a.gutter) + (cw - w) / 2;
      const oy = bottom + (ch - h) / 2;
      const name = `P${j + 1}`;
      xobjects[name] = formXObject(out, copier, pages[j]);
      // clip to the trimmed box on the sheet, then draw the whole page scaled
      // so the box lands there
      ops.push(`q ${f3(ox)} ${f3(oy)} ${f3(w)} ${f3(h)} re W n `
        + `${f5(s)} 0 0 ${f5(s)} ${f3(ox - s * b[0])} ${f3(oy - s * b[1])} cm /${name} Do Q`);
      if (a.frame) ops.push(`q 0.5 w ${f3(ox)} ${f3(oy)} ${f3(w)} ${f3(h)} re S Q`);
      // The slug, kept once: drawn a second time from the first page, moved
      // down to just inside the top of the trimmed box when the page is blank
      // there (as an article's first page usually is), else just above it.
      if (j === kept[0] && slug?.boxes.has(j + 1)) {
        const [x0, y0, x1, y1] = slug.boxes.get(j + 1);   // from the top left
        const H = sizes[j][1];
        const sh = (y1 - y0) * s;                          // its height on the sheet
        const inkTop = raw.get(j + 1)?.[3];                // where this page's ink begins
        const room = inkTop === undefined ? 0 : inkTop - (H - b[3]);
        const dy = room >= y1 - y0 + 6 ? oy + h - 2 * s - sh : oy + h + 3;
        if (dy + sh <= sheetH - 4) {
          const sx = ox + s * (x0 - b[0]);
          ops.push(`q ${f3(sx - 1)} ${f3(dy - 1)} ${f3(s * (x1 - x0) + 2)} ${f3(sh + 2)} re W n `
            + `${f5(s)} 0 0 ${f5(s)} ${f3(ox - s * b[0])} ${f3(dy - s * (H - y1))} cm /${name} Do Q`);
        }
      }
    });
    sheet.node.set(PDFName.of('Resources'), out.context.obj({ XObject: xobjects }));
    sheet.node.set(PDFName.of('Contents'),
      out.context.register(out.context.flateStream(ops.join('\n'))));
  }
  // no object streams: they need PDF 1.5, and the oldest printer firmware
  // this has to get through is fussier than any viewer
  return {
    scale, pages: pages.length, sheets: plan.length, cover,
    pdf: await out.save({ useObjectStreams: false }),
  };
}
