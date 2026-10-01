// What core.js needs from its surroundings, for Node: pdf.js set up to find its
// own fonts and decoders on disk, and a canvas, which Node does not have.
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')) + '/';

export const env = {
  openPdfjs: (data) => getDocument({
    data,
    standardFontDataUrl: root + 'standard_fonts/',
    cMapUrl: root + 'cmaps/',
    cMapPacked: true,
    wasmUrl: root + 'wasm/',
    iccUrl: root + 'iccs/',
    verbosity: 0,
  }).promise,
  createCanvas,
};
