// Paragraph numbers for books without page numbers. APA 7 (section 8.28) asks for
// "(Author, Year, Heading section, para. 3)": the count restarts at the nearest
// heading. Block quotes and lists count as part of the paragraph around them,
// and text that resumes at the margin after one continues that paragraph.
//
// A paragraph starts at the first line after a heading, and then:
//   - in books that indent first lines: at an indented line whose next line
//     goes back to the margin (a run of indented lines is a quote or a list,
//     and so is an indented line set off from the text above by extra space);
//   - in books that space paragraphs apart: at a line after a larger gap, or at
//     the top of a page when the previous page ended a sentence on a short line.

import { cleanText, endsSentence } from "./text.js";

const MARKER = /^\s*([•●▪■◦‣∙·–—-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s/u;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);
const family = (font) => font.replace(/[-,].*$/, "").replace(/(MT|PS)$/, "");

/**
 * Numbers every paragraph of the document in reading order. Sets `firstPara` on
 * each heading event and returns paraAt(page, x, y), the paragraph at a position.
 * Expects the events to be sorted already (their `col` is used).
 */
export function numberParagraphs(pages, body, columns, headings) {
  const em = body.size;
  const isBodyText = (line) =>
    line.letters > 0 && family(line.style.font) === family(body.font) && Math.abs(line.style.size - body.size) <= Math.max(0.6, em * 0.05);
  const colOf = (page, x) => (columns[page] && x >= columns[page].mid ? 1 : 0);

  // Visual lines: words that the PDF stores separately but sit on one line are one line.
  const visual = pages.map((page) => {
    const groups = [];
    for (const line of page.lines) {
      if (line.furniture) continue;
      const col = colOf(page.index, line.x0);
      let v = groups.find((g) => g.col === col && Math.abs(g.y0 - line.y0) < 2);
      if (!v) {
        v = { page: page.index, col, y0: line.y0, y1: line.y1, x0: line.x0, x1: line.x1, parts: [], bodyLetters: 0, otherLetters: 0, bullet: false };
        groups.push(v);
      }
      v.x0 = Math.min(v.x0, line.x0);
      v.x1 = Math.max(v.x1, line.x1);
      v.y1 = Math.max(v.y1, line.y1);
      v.parts.push(line);
      if (isBodyText(line)) v.bodyLetters += line.letters;
      else v.otherLetters += line.letters;
      if (line.bullet) v.bullet = true;
    }
    for (const v of groups) {
      v.parts.sort((a, b) => a.x0 - b.x0);
      v.text = cleanText(v.parts.map((l) => l.text).join(" ")).replace(/\s+/g, " ").trim();
      v.isBody = v.bodyLetters > 0 && v.bodyLetters >= v.otherLetters;
      v.marker = v.bullet || MARKER.test(v.text);
    }
    groups.sort((a, b) => a.col - b.col || a.y0 - b.y0 || a.x0 - b.x0);
    groups.forEach((v, i) => {
      if (i > 0 && groups[i - 1].col === v.col) v.prev = groups[i - 1];
    });
    return groups;
  });

  // Lines of standalone headings are not paragraph text.
  for (const h of headings) {
    if (h.y < 0 || h.source === "run-in") continue;
    for (const v of visual[h.page]) if (v.y0 >= h.y - 1 && v.y0 <= h.y1 + 1) v.heading = true;
  }

  // Left margin and right edge of the text, per page and column.
  const mode = (values) => {
    const counts = new Map();
    for (const x of values) counts.set(x, (counts.get(x) || 0) + 1);
    let best = null;
    let n = 0;
    for (const [x, c] of counts) if (c > n || (c === n && x < best)) [best, n] = [x, c];
    return best;
  };
  const bodyLines = visual.flat().filter((v) => v.isBody && !v.heading);
  const docMargin = [0, 1].map((c) => mode(bodyLines.filter((v) => v.col === c).map((v) => Math.round(v.x0))));
  const edges = new Map();
  const edgesOf = (page, col) => {
    const key = page + ":" + col;
    if (!edges.has(key)) {
      const own = visual[page].filter((v) => v.col === col && v.isBody && !v.heading);
      const margin = own.length >= 3 ? mode(own.map((v) => Math.round(v.x0))) : docMargin[col];
      const right = own.length ? Math.max(...own.map((v) => v.x1)) : Infinity;
      edges.set(key, { margin, right });
    }
    return edges.get(key);
  };
  const indented = (v) => {
    const d = v.x0 - edgesOf(v.page, v.col).margin;
    return d >= em * 0.5 && d <= em * 4;
  };
  const complete = (v) => endsSentence(v.text) && v.x1 < edgesOf(v.page, v.col).right - em * 2;

  // Indented style if first-line indents are common; otherwise paragraphs are spaced apart.
  let firstLineIndents = 0;
  const pitches = [];
  for (let i = 0; i + 1 < bodyLines.length; i++) {
    const a = bodyLines[i];
    const b = bodyLines[i + 1];
    if (a.page !== b.page || a.col !== b.col) continue;
    if (indented(a) && !indented(b)) firstLineIndents++;
    const d = b.y0 - a.y0;
    if (d > 0 && d < em * 3) pitches.push(d);
  }
  const indentStyle = firstLineIndents >= Math.max(3, bodyLines.length * 0.01);
  pitches.sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : em * 1.2;
  // Extra space above a line that follows ordinary text (not a centred caption).
  const spacedFromText = (v) => {
    const p = v.prev;
    if (!p || p.heading || !p.isBody || p.x0 - edgesOf(p.page, p.col).margin > em * 4) return false;
    return v.y0 - p.y0 > pitch * 1.35;
  };

  // Walk headings and lines in reading order.
  const byPage = pages.map(() => []);
  for (const h of headings) byPage[h.page].push({ kind: "heading", h, col: h.col || 0, y: h.y, x: h.x });
  for (const lines of visual) for (const v of lines) byPage[v.page].push({ kind: "line", v, col: v.col, y: v.y0, x: v.x0 });

  let para = 0;
  let fresh = true; // the next body line starts a paragraph
  let run = []; // consecutive indented lines, decided once the run ends
  let prevBody = null;
  let afterBlock = false;
  const start = (v) => {
    para++;
    v.para = para;
  };
  const cont = (v) => {
    v.para = Math.max(para, 1);
  };
  const flushRun = () => {
    if (!run.length) return;
    const first = run[0];
    const sameIndent = run.every((v) => Math.abs(v.x0 - first.x0) <= 2);
    if (run.length > 1 && sameIndent && run.every((v) => !v.marker && complete(v))) {
      run.forEach(start); // several one-line paragraphs, such as dialogue
    } else {
      const firstStarts = !first.marker && !spacedFromText(first) && (run.length === 1 || run[1].marker || Math.abs(run[1].x0 - first.x0) > 2);
      run.forEach((v, i) => (i === 0 && firstStarts ? start(v) : cont(v)));
    }
    run = [];
  };

  for (const items of byPage) {
    items.sort((a, b) => a.col - b.col || a.y - b.y || (a.kind === b.kind ? 0 : a.kind === "heading" ? -1 : 1) || a.x - b.x);
    for (const it of items) {
      if (it.kind === "heading") {
        flushRun();
        fresh = true;
        prevBody = null;
        afterBlock = false;
        it.h.firstPara = para + 1;
        continue;
      }
      const v = it.v;
      if (v.heading) continue;
      if (!v.isBody) {
        // Quotes, captions and other text in a different style belong to the paragraph around them.
        flushRun();
        v.para = fresh ? para + 1 : Math.max(para, 1);
        afterBlock = true;
        continue;
      }
      if (fresh) {
        flushRun();
        start(v);
        fresh = false;
      } else if (indentStyle) {
        if (indented(v)) {
          run.push(v);
          continue;
        }
        flushRun();
        cont(v);
      } else {
        const sameColumn = prevBody && prevBody.page === v.page && prevBody.col === v.col;
        const gap = sameColumn && v.y0 - prevBody.y0 > pitch * 1.35;
        const newPageOrColumn = prevBody && !sameColumn && complete(prevBody);
        const startsSentence = !/^\p{Ll}/u.test(v.text);
        if (!v.marker && !indented(v) && !afterBlock && startsSentence && (gap || newPageOrColumn)) start(v);
        else cont(v);
        afterBlock = v.marker || indented(v);
      }
      prevBody = v;
      if (indentStyle) afterBlock = false;
    }
  }
  flushRun();

  return function paraAt(page, x, y) {
    const col = colOf(page, x);
    let found = null;
    for (const v of visual[page] || []) {
      if (v.col !== col || v.para === undefined) continue;
      if (v.y0 <= y + 1) found = v;
      else if (!found) found = v;
    }
    return found ? found.para : 1;
  };
}

/** "Chapter 1, para. 3", "Key Concepts section, para. 3", "“The Relationship of Powerlessness” section, paras. 2–3" */
export function paragraphLocator(heading, topLevel, from, to) {
  const paras = from === to ? `para. ${from}` : `paras. ${from}–${to}`;
  if (!heading) return paras;
  const chapter = topLevel && heading.title.match(/^(?:ch(?:apter)?\.?\s*)?(\d{1,2})[:.]?\s+\S/i);
  if (chapter) return `Chapter ${chapter[1]}, ${paras}`;
  return `${sectionName(heading.title)} section, ${paras}`;
}

/** APA: a long heading is shortened and put in quotation marks. */
function sectionName(title) {
  const t = title.replace(/^\d+(\.\d+)*\s+/, "").replace(/[.;,]+$/, "").trim();
  const words = t.split(/\s+/);
  if (words.length <= 6 && !/[?!:]/.test(t)) return t;
  const short = words.slice(0, Math.min(words.length, 4));
  const weak = (w) => {
    const letters = w.toLowerCase().replace(/[^\p{L}]/gu, "");
    return !letters || SMALL_WORDS.has(letters);
  };
  while (short.length > 1 && weak(short[short.length - 1])) short.pop();
  return `“${short.join(" ").replace(/[?!:;,.]+$/, "")}”`;
}
