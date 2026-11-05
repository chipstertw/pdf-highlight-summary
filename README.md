# PDF Highlight Summarizer

**Use it here: https://chipstertw.github.io/pdf-highlight-summary/**

Turn the highlights and notes in a PDF into a printable study summary, organised the way the book is:

```
Chapter
  Section
    Sub-section …
      PDF 42 | (Corey, 2017, p. 19)
        ▌ Highlighted text (colour bar = the highlight colour)
          Note: your note, when the highlight has one
```

It is built for highlights made in **Preview on Mac, iPad and iPhone**. It also works with other apps that save standard PDF highlight, underline and strike-through annotations into the file.

Everything runs in the browser. **The PDF is never uploaded**, and there is no server or AI involved, so the same PDF always gives the same summary.

## Using it

1. Open the [web page](https://chipstertw.github.io/pdf-highlight-summary/).
2. Drop in a highlighted PDF. A 500-page textbook usually takes under half a minute.
3. Check the APA reference and file name it found, and edit them if needed. Text between `*asterisks*` is set in italics.
4. Click **Download summary PDF**.

The download is US Letter and printer-friendly. Its headings appear as bookmarks in Preview's sidebar.

## What it does

| | |
|---|---|
| **Chapters and sections** | Taken from the PDF's bookmarks when it has them. |
| **Smaller headings** | Detected from the type on the page: bigger or bolder lines, and bold "run-in" headings that start a paragraph. They are nested by how prominent their style is. |
| **Highlight text** | Read from the page under each highlight. Words split by a line-end hyphen are rejoined, checked against the book's own vocabulary so that real compounds such as *self-awareness* keep their hyphen. Bulleted and numbered lists stay as lists. |
| **Page numbers and citations** | Each group of highlights is labelled with its PDF page and an APA 7 in-text citation for the printed page, e.g. `PDF 42 \| (Corey, 2017, p. 19)`. The printed page comes from the PDF's page labels, or from the running heads when it has none. Author and year come from the file name, so editing it updates every citation. |
| **Paragraph numbers** | For books without page numbers, such as e-books converted to PDF, the citation names the paragraph instead, e.g. `PDF 25 \| (Proctor, 2017, Chapter 1, para. 2)`. Paragraphs are counted from the nearest heading, as APA asks, and long headings are shortened in quotation marks. Block quotes and lists count as part of the paragraph around them. |
| **Split sentences** | One sentence highlighted in two parts, or across a page break, becomes one entry (e.g. `PDF 112–113 \| (Corey, 2017, pp. 89–90)`). |
| **Highlighted headings** | When you highlighted a heading itself, the heading is marked with the colour instead of being repeated. |
| **Notes** | Shown under the highlight they belong to. Standalone sticky notes appear where they sit on the page. |
| **Running heads, footers, margin tags** | Ignored, so they never end up inside a highlight. |
| **APA reference** | Built from the PDF's title field, title page and copyright page. If the PDF contains a DOI or ISBN, you can optionally fill gaps from Crossref or Open Library; only the number is sent. |
| **File name** | `Author (Year) Title.pdf`, for example `Corey (2017) Theory and Practice of Counseling and Psychotherapy.pdf`. |

### Known limits

- Scanned PDFs (images of pages) need text recognition (OCR) before their highlights can be read.
- Shapes, drawings and boxes drawn with Markup are not text highlights and are skipped.
- Heading detection relies on typography. A book with unusual layouts may nest a heading one level off; the bookmarks, when present, keep chapters and main sections exact.
- Paragraph counting relies on how the book marks paragraphs (first-line indents or extra space). A quotation set in normal type and indented like a paragraph can be miscounted, so check the first few citations against the book.
- The bundled fonts cover Latin, Greek and Cyrillic. Other scripts (for example Chinese) are not drawn correctly in the summary PDF yet.

## Publishing your own copy on GitHub Pages

The app is a static site with no build step.

1. Fork this repository, or create a new one and push these files to it.
2. In the repository, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick `main` and `/ (root)`.
3. After a minute the app is live at `https://<your-username>.github.io/pdf-highlight-summary/`. The footer links back to the repository automatically.

## Running it locally

Any static file server works. The app has to be served over `http://` (not opened as a `file://`), because it uses a web worker and WebAssembly.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

### Command line

The same pipeline runs in Node.js 20 or later, which is handy for testing or batch use:

```bash
node tools/summarize.mjs book.pdf output-folder
node tools/summarize.mjs book.pdf --outline
node tools/debug-page.mjs book.pdf 42
node tools/render-pages.mjs summary.pdf png-folder 1 3
node --test tools/
```

`--outline` prints the result as text. `debug-page` shows the lines, font styles and highlights of one page, which helps when tuning heading detection. `node --test tools/` runs the automated checks.

## How the code is organised

| File | Job |
|---|---|
| `src/read-pdf.js` | Reads text lines with font styles, annotations and the characters under them, bookmarks, page labels and metadata (MuPDF). |
| `src/analyze.js` | Finds running heads, body text style, headings and their levels, printed page numbers, then builds the heading › page › highlight tree. |
| `src/paragraphs.js` | Counts paragraphs from the nearest heading and words APA paragraph locators, for books without page numbers. |
| `src/text.js` | Text clean-up: ligatures, odd spaces, hyphenation repair. |
| `src/reference.js` | APA 7 reference, file name, optional DOI/ISBN lookup. |
| `src/render-pdf.js` | Draws the summary PDF (pdf-lib). |
| `src/worker.js` | Runs reading and analysis off the main thread. |
| `src/main.js`, `index.html`, `app.css` | The web page. |

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).

The app bundles [MuPDF.js](https://mupdf.com) (AGPL-3.0), which is why the app uses the same licence. It also bundles [pdf-lib](https://pdf-lib.js.org) and [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) (MIT), and the Source Serif 4 and Source Sans 3 fonts (SIL Open Font License 1.1). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
