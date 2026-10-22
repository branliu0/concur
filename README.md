# concur

Print a PDF two pages to a sheet by trimming away the wasted margins.

Law review articles and Supreme Court opinions have large margins when printed
on letter paper: the text was set for a much smaller page. Printing two pages
per sheet the usual way shrinks those margins along with the text, so you get
tiny print surrounded by blank paper. concur measures where the text actually
is and crops to it before laying the pages out side by side, so it usually
prints close to its original size on half the paper.

(To concur is, literally, to run together.)

## The web page

**https://branliu0.github.io/concur/** does all of this in the browser: drop
PDFs on it and download the results. Files are never uploaded, it keeps working
offline once loaded, and its Content-Security-Policy stops it contacting any
other site. Its source is `web/`.

```
npm install
npm run site                  # builds the page into _site/
```

`.github/workflows/pages.yml` builds and publishes it to GitHub Pages on every
push to `main`.

## The command line

Needs [Node](https://nodejs.org/).

```
npm install
node src/cli.js brief.pdf     # -> brief~(2 per page).pdf, next to the original
```

The `~` in the output name makes it sort right after the source in Finder.
The page and the command line run the same code, `src/core.js`: pdf.js renders
the pages and reads their text, pdf-lib does the layout.

`npm test` dry-runs your own PDFs in `samples/` against a recorded report, to
show whether a change moved anything; see `test/samples.js`. `npm run
test:examples` does the same for the web page's two public examples, and the
GitHub workflow runs it before publishing.

## How it decides

1. **Measure.** Render the first 40 pages at 50 dpi and take the bounding box
   of the ink on each. The low resolution is deliberate: speckle along the edge
   of a scan blurs away, while text stays dark. Odd and even pages are measured
   separately, since scanned books place the text block differently on left-
   and right-hand pages.
2. **Ignore download stamps.** Publishers stamp every page — JSTOR's "This
   content downloaded from …" under the text block, OUP's down the side,
   Cambridge Core's across the foot, HeinOnline's, SSRN's. concur reads the
   extracted text and drops the lines that match (see `STAMPS` in the script),
   taking the whole block with them, since JSTOR's middle line is a bare IP
   address and date. Reading the words is what makes this safe: JSTOR's footer
   sits exactly where a footnote would, so no amount of geometry tells them
   apart.

   Some law reviews' templates print a slug above the running head on every
   page — the production file's name and when it was last saved, between two
   rules — or leave the two rules with nothing between them. A line that
   carries a date and repeats unchanged on every page is a slug: no running
   head does that. It is left out of the measurement and drawn once, at the
   top of the first page. A band at the top or bottom holding nothing but
   rules is left out too, since a rule has nothing to read in it.

   A typesetter's proof has the opposite problem: crop marks and a slug line
   out at the very edges of an oversized sheet. The file says where the real
   page ends (its trim box), and anything outside that is ignored.

   In a scan with no text layer, a stamp is caught by shape instead: a thin
   strip standing clear of the text. A band at the top or bottom also has to be
   *wider* than the text block, so running heads and page numbers are never
   clipped. `--keep-edges` turns both off.
3. **Set aside pages unlike the rest.** JSTOR and HeinOnline downloads lead
   with a cover page about the download itself, and so do the law school
   repositories built on bepress Digital Commons. Page 1 is recognised as one by
   what it says, and left out (`--keep-cover` keeps it). Any other page whose
   size differs from the document's usual one is left out of the measurement,
   placed untrimmed, and not allowed to set the scale for everything else.

   A page can also differ in its content rather than its size: journal front
   matter (an abstract, a table of contents) often runs the full width of the
   page while the article sits in a narrow block. Sizing everything to fit
   those would shrink the article, so a page whose text block is much *wider*
   than the rest gets a sheet to itself at full size. Only width counts — a
   page's measured height moves around with its footnotes. Those sheets stay
   portrait, so the output mixes orientations — printers cope, and
   `--oversize 2up` turns it off.
4. **Check it's legible.** Read the size the text is set in (the commonest
   size is the body; the smallest size with a real share of the characters is
   the footnotes) and work out what it comes out at once shrunk, which is
   reported as `text 11 pt → 8.9 pt, footnotes 9 pt → 7.3 pt`. If the smallest
   print would come out under 7 pt, the file is skipped: 1-up would read
   better. `--force` makes it anyway, with a warning, and `--min-size` moves
   the threshold. A scan has no text to read, so there the old test applies:
   skipped if the text would end up below 85% of its original size
   (`--min-scale`).
5. **Lay out.** Each page is cropped to its box (plus 10pt of breathing room)
   and placed on a landscape sheet at one scale for the whole document.

## Options

| Option | Default | |
|---|---|---|
| `--no-trim` | | Plain 2-up: leave the margins as they are |
| `--trim "L B R T"` | | Set content margins yourself, in points. Eight numbers set odd pages, then even. Handy for cutting a stamp under the text, like JSTOR's |
| `--keep-edges` | | Treat download stamps as content instead of ignoring them |
| `--keep-cover` | | Keep the cover page JSTOR, HeinOnline or a school's repository puts in front |
| `-m, --margin` | `10` | Whitespace kept around the content, pt |
| `-s, --scale` | `0.90` | Fraction of the sheet used, leaving a printable border |
| `--gutter` | `36` | Gap between the two pages, pt |
| `--paper` | `letter` | `letter`, `legal`, or `a4` |
| `--oversize` | `1up` | `1up` gives pages with a much wider text block their own sheet; `2up` shrinks them in with the rest |
| `-f, --force` | | Make it even if the text would shrink a lot |
| `--min-size` | `7` | Skip if the smallest text would print below this, pt |
| `--min-scale` | `0.85` | The same test by shrink, for files with no text to read |
| `-n, --dry-run` | | Measure and report without writing anything |
| `--sample` / `--pct` / `--dpi` | `40` / `5` / `50` | Measurement tuning; `--pct 0` never clips any page's content |

Progress and measurements go to stderr, and the output path goes to stdout.
The exit status is 1 when a file is skipped or fails.

## Finder Quick Action (macOS)

Right-click one or more PDFs → **Quick Actions → concur 2-up**.

1. Put `concur` and the wrapper on your `PATH`:
   `ln -s ~/dev/pdf2page/src/cli.js ~/bin/concur` and
   `ln -s ~/dev/pdf2page/concur-quickaction ~/bin/concur-quickaction`
2. Copy the workflow into place:
   `cp -R "concur 2-up.workflow" ~/Library/Services/`
3. Turn it on in **System Settings → General → Login Items & Extensions →
   Finder** (it won't show in the menu until you do).

Every run ends in a dialog. **Open** opens the result. Files are always made
(the wrapper passes `--force`), and one whose smallest print comes out under
7 pt is marked ⚠ rather than skipped. The
wrapper expects `concur` at `~/bin/concur` and looks for node in
`/opt/homebrew/bin` or `/usr/local/bin`; edit `concur-quickaction` if yours
lives elsewhere.

concur began as `pdf2page`, a Python script; it is in this repository's
history up to the JavaScript port.

## License

The code is MIT-licensed; see `LICENSE`. The example PDFs in `web/examples/`
are not covered by it: *Obergefell v. Hodges* is from the U.S. Reports, a work
of the U.S. government, and Holmes's *The Path of the Law* is from JSTOR's
Early Journal Content, free to share for non-commercial use.
