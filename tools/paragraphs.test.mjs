// Paragraph locators for books without page numbers, on small hand-built pages.
// Run with: node --test tools/

import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze.js";
import { paragraphLocator } from "../src/paragraphs.js";
import { inTextCitation } from "../src/reference.js";
import { pageLabel } from "../src/render-pdf.js";

const MARGIN = 72;
const INDENT = 90;
const FULL = "words that fill a whole line of ordinary body text in this sample book";

/**
 * Builds the reader's output from a list of pages, each a list of lines:
 * { text, x, x1, size, bold, gap, mark }. Lines are laid out top to bottom,
 * 14pt apart plus any extra `gap`. `mark` puts a highlight on the line.
 */
function makeDoc(pageSpecs, { labels = false } = {}) {
  let n = 0;
  let idx = 0;
  const pages = pageSpecs.map((spec, index) => {
    const lines = [];
    const marks = [];
    let y = 72;
    for (const l of spec) {
      y += l.gap || 0;
      const size = l.size || 12;
      const x0 = l.x ?? MARGIN;
      const x1 = l.x1 ?? 540;
      const line = {
        n: n++, block: 0, x0, x1, y0: y, y1: y + size, c0: idx, c1: idx + l.text.length - 1, text: l.text, bullet: false,
        spans: [{ text: l.text, font: l.bold ? "Serif-Bold" : "Serif", size, color: "#000000", bold: !!l.bold, italic: false, x0, x1 }],
      };
      idx += l.text.length;
      lines.push(line);
      if (l.mark) marks.push({ type: "Highlight", color: "#facd5a", note: "", frags: [{ n: line.n, text: l.text, i0: line.c0, i1: line.c1, x: x0 }], x: x0, y: line.y0 });
      y += size + 2;
    }
    return { index, label: labels ? String(index + 1) : "", width: 612, height: 792, lines, marks, notes: [] };
  });
  return { pageCount: pages.length, meta: {}, outline: [], hasPageLabels: labels, pages };
}

const pageGroups = (nodes, out = []) => {
  for (const node of nodes) {
    if (node.type === "heading") pageGroups(node.children, out);
    else out.push(node);
  }
  return out;
};
const locatorOf = (summary, start) => pageGroups(summary.tree).find((g) => g.items.some((it) => it.text.startsWith(start)))?.locator;

// A book that indents the first line of each paragraph.
const indented = [
  [
    { text: "Section One", size: 18, bold: true },
    { text: "Opening paragraph " + FULL, gap: 10 },
    { text: "and the first paragraph ends here.", x1: 300 },
    { text: "Second paragraph " + FULL, x: INDENT },
    { text: "Middle of the second paragraph " + FULL },
    { text: "which then quotes as follows:", x1: 300 },
    { text: "Quoted words in smaller type set apart", x: 100, size: 10, gap: 10, mark: true },
    { text: "from the text around them.", x: 100, size: 10, x1: 260 },
    { text: "The paragraph continues after the quote " + FULL, gap: 10, mark: true },
    { text: "until it ends.", x1: 200 },
    { text: "Third paragraph " + FULL, x: INDENT, mark: true },
    { text: "and it ends.", x1: 200 },
    { text: "Fourth paragraph " + FULL, x: INDENT },
    { text: "and the author explains:", x1: 300 },
    { text: "For this to happen these conditions are needed:", x: INDENT, x1: 420, gap: 10, mark: true },
    { text: "1) The first condition.", x: INDENT, x1: 260 },
    { text: "2) The second condition.", x: INDENT, x1: 260 },
    { text: "The text goes on after the list " + FULL, gap: 10 },
    { text: "and the fourth paragraph ends.", x1: 300 },
    { text: "Fifth paragraph " + FULL, x: INDENT, mark: true },
    { text: "Fifth paragraph runs on " + FULL },
  ],
  [
    { text: "continuing at the top of the next page " + FULL, mark: true },
    { text: "before the fifth paragraph ends.", x1: 300 },
    { text: "Sixth paragraph " + FULL, x: INDENT, mark: true },
    { text: "and the sixth paragraph ends.", x1: 300 },
  ],
];

test("indented paragraphs are counted from the nearest heading", () => {
  const summary = analyze(makeDoc(indented));
  assert.equal(locatorOf(summary, "Third paragraph"), "Section One section, para. 3");
  assert.equal(locatorOf(summary, "Sixth paragraph"), "Section One section, para. 6");
});

test("a block quote belongs to the paragraph around it, as does the text after it", () => {
  const summary = analyze(makeDoc(indented));
  assert.equal(locatorOf(summary, "Quoted words"), "Section One section, para. 2");
  assert.equal(locatorOf(summary, "The paragraph continues"), "Section One section, para. 2");
});

test("an indented line set off by extra space, and a list, belong to the paragraph before", () => {
  const summary = analyze(makeDoc(indented));
  assert.equal(locatorOf(summary, "For this to happen"), "Section One section, para. 4");
  assert.equal(locatorOf(summary, "Fifth paragraph"), "Section One section, para. 5");
});

test("a paragraph that runs over a page break keeps its number", () => {
  const summary = analyze(makeDoc(indented));
  assert.equal(locatorOf(summary, "continuing at the top"), "Section One section, para. 5");
});

test("paragraphs separated by space instead of indents are counted too", () => {
  const spaced = [
    [
      { text: "Section Two", size: 18, bold: true },
      { text: "First paragraph " + FULL, gap: 10 },
      { text: "and it ends.", x1: 200 },
      { text: "Second paragraph " + FULL, gap: 8 },
      { text: "and it ends.", x1: 200 },
      { text: "Third paragraph " + FULL, gap: 8, mark: true },
      { text: "Third paragraph carries on " + FULL },
    ],
    [
      { text: "continued on the next page " + FULL, mark: true },
      { text: "and it ends.", x1: 200 },
      { text: "Fourth paragraph " + FULL, gap: 8, mark: true },
      { text: "and it ends.", x1: 200 },
    ],
  ];
  const summary = analyze(makeDoc(spaced));
  assert.equal(locatorOf(summary, "Third paragraph"), "Section Two section, para. 3");
  assert.equal(locatorOf(summary, "continued on the next page"), "Section Two section, para. 3");
  assert.equal(locatorOf(summary, "Fourth paragraph"), "Section Two section, para. 4");
});

test("books with page numbers get no paragraph numbers", () => {
  const summary = analyze(makeDoc(indented, { labels: true }));
  assert.ok(pageGroups(summary.tree).every((g) => !g.locator));
  assert.equal(summary.stats.paragraphLocators, 0);
});

test("highlights from different paragraphs of one page get their own page labels", () => {
  const summary = analyze(makeDoc(indented));
  const firstPage = pageGroups(summary.tree).filter((g) => g.pdfFrom === 1);
  assert.deepEqual(
    firstPage.map((g) => g.locator),
    ["Section One section, para. 2", "Section One section, para. 3", "Section One section, para. 4", "Section One section, para. 5"],
  );
});

test("locators follow APA: chapter, section, shortened headings and ranges", () => {
  assert.equal(paragraphLocator({ title: "1 Why does power in therapy matter?" }, true, 2, 2), "Chapter 1, para. 2");
  assert.equal(paragraphLocator({ title: "Key Concepts" }, false, 3, 3), "Key Concepts section, para. 3");
  assert.equal(paragraphLocator({ title: "Person-centred theory" }, false, 2, 3), "Person-centred theory section, paras. 2–3");
  assert.equal(
    paragraphLocator({ title: "The relationship of powerlessness to the experience of psychological distress" }, false, 1, 1),
    "“The relationship of powerlessness” section, para. 1",
  );
  assert.equal(paragraphLocator({ title: "Industrialised therapy – the case of IAPT" }, false, 4, 4), "“Industrialised therapy” section, para. 4");
  assert.equal(paragraphLocator(null, false, 5, 5), "para. 5");
});

test("the page label carries the in-text citation", () => {
  const page = { pdfFrom: 42, pdfTo: 42, labelFrom: "19", labelTo: "19", locator: "" };
  assert.equal(pageLabel(page, "Corey (2017) Theory and Practice"), "PDF 42  |  (Corey, 2017, p. 19)");
  assert.equal(pageLabel({ ...page, pdfTo: 43, labelTo: "20" }, "Corey (2017) Theory"), "PDF 42–43  |  (Corey, 2017, pp. 19–20)");
  assert.equal(pageLabel({ pdfFrom: 25, pdfTo: 25, labelFrom: "", labelTo: "", locator: "Chapter 1, para. 2" }, "Proctor (2017) The Dynamics"), "PDF 25  |  (Proctor, 2017, Chapter 1, para. 2)");
  assert.equal(pageLabel({ pdfFrom: 3, pdfTo: 3, labelFrom: "", labelTo: "", locator: "" }, "Corey (2017) Theory"), "PDF 3");
});

test("the in-text citation takes author and year from the file name", () => {
  assert.equal(inTextCitation("Proctor (2017) The Dynamics of Power", "Chapter 1, para. 2"), "(Proctor, 2017, Chapter 1, para. 2)");
  assert.equal(inTextCitation("Smith et al. (2019) A Study", "Method section, para. 4"), "(Smith et al., 2019, Method section, para. 4)");
  assert.equal(inTextCitation("Untitled", "para. 1"), "(para. 1)");
});
