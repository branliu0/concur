# pdf2page

Print a PDF 2-up (two pages side by side on one landscape sheet) without the
text shrinking to nothing, by trimming away the empty margins first.

Law review articles, briefs, and scanned book chapters often sit a small block
of text in the middle of a big page. Put two of those pages side by side on one
sheet as they are and the text ends up tiny. `pdf2page` measures where the ink
actually is and crops to it before laying the pages out, so a booklet-format
brief usually prints 2-up at close to its original size.

```
pdf2page brief.pdf        # -> brief~2up.pdf, next to the original
```

The `~` in the output name makes it sort right after the source in Finder.

## Install

Needs macOS or Linux with:

- [uv](https://docs.astral.sh/uv/), which runs the script and fetches its
  Python dependencies (pypdf, Pillow, numpy) on first use
- poppler's `pdftoppm`, used to measure the margins: `brew install poppler`

Then put `pdf2page` somewhere on your `PATH`, e.g.

```
ln -s ~/dev/pdf2page/pdf2page ~/bin/pdf2page
```

### Finder Quick Action (macOS)

Right-click one or more PDFs → **Quick Actions → pdf2page 2-up**.

1. Symlink the wrapper next to `pdf2page`:
   `ln -s ~/dev/pdf2page/pdf2page-quickaction ~/bin/pdf2page-quickaction`
2. Copy the workflow into place:
   `cp -R "pdf2page 2-up.workflow" ~/Library/Services/`
3. Turn it on in **System Settings → General → Login Items & Extensions →
   Finder** (it won't show in the menu until you do).

Every run ends in a dialog. **Open** opens the result, and when a file was
skipped for being too small, **Make anyway** redoes it with `--force`. The
wrapper expects `pdf2page` at `~/bin/pdf2page` and looks for uv in
`~/.local/bin` and poppler in `/opt/homebrew/bin`; edit
`pdf2page-quickaction` if yours live elsewhere.

## How it decides

1. **Measure.** Render the first 40 pages at 50 dpi and take the bounding box
   of the ink on each. The low resolution is deliberate: speckle along the edge
   of a scan blurs away, while text stays dark. Odd and even pages are measured
   separately, since scanned books place the text block differently on left-
   and right-hand pages.
2. **Ignore side stamps.** A thin strip of ink along the left or right edge,
   standing apart from the text, is treated as a download stamp (OUP's
   "Downloaded from academic.oup.com …") and left out of the box.
   `--keep-edges` turns this off.
3. **Set aside cover pages.** JSTOR and HeinOnline downloads lead with a
   cover page, often a different size and nearly full of text. Pages whose size
   differs from the document's usual one are left out of the measurement,
   placed untrimmed, and not allowed to set the scale for everything else.
4. **Check it's worth it.** If the text would still end up below 85% of its
   original size, the file is skipped: 1-up would read better. `--force`
   overrides, `--min-scale` moves the threshold.
5. **Lay out.** Each page is cropped to its box (plus 10pt of breathing room)
   and placed on a landscape sheet at one scale for the whole document.

## Options

| Option | Default | |
|---|---|---|
| `-p, --preset` | `auto` | `auto` measures; `booklet` / `full` use fixed margins; `none` doesn't trim |
| `--trim "L B R T"` | | Set content margins yourself, in points. Eight numbers set odd pages, then even. Handy for cutting a stamp under the text, like JSTOR's |
| `-m, --margin` | `10` | Whitespace kept around the content, pt |
| `-s, --scale` | `0.90` | Fraction of the sheet used, leaving a printable border |
| `--gutter` | `36` | Gap between the two pages, pt |
| `--paper` | `letter` | `letter`, `legal`, or `a4` |
| `--frame` | | Draw a box around each page |
| `-f, --force` | | Make it even if the text would shrink a lot |
| `--min-scale` | `0.85` | Skip threshold |
| `-n, --dry-run` | | Measure and report without writing anything |
| `--sample` / `--pct` / `--dpi` | `40` / `5` / `50` | Measurement tuning; `--pct 0` never clips any page's content |

Progress and measurements go to stderr, and the output path goes to stdout.
The exit status is 1 when a file is skipped or fails.
