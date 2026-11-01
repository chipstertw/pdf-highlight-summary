// Draws the summary as a printer-friendly US Letter PDF with pdf-lib:
// the APA reference on top, then headings nested by level, page numbers,
// each highlight with a bar in its highlight colour, and notes underneath.
// Headings become bookmarks so the summary can be navigated in Preview's sidebar.
//
// pdf-lib and fontkit are passed in so this file runs in the browser and in Node.

export const FONT_FILES = {
  serif: "fonts/SourceSerif4_400Regular.ttf",
  serifItalic: "fonts/SourceSerif4_400Regular_Italic.ttf",
  sans: "fonts/SourceSans3_400Regular.ttf",
  sansSemibold: "fonts/SourceSans3_600SemiBold.ttf",
  sansBold: "fonts/SourceSans3_700Bold.ttf",
};

const PAGE = { width: 612, height: 792 };
const MARGIN = { left: 64, right: 64, top: 66, bottom: 60 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const INDENT_STEP = 12;
const MAX_INDENT_LEVELS = 5;
const INK = "#1b1b1b";
const MUTED = "#6a6a6a";
const RULE = "#cfcfcf";

const HEADING_STYLES = [
  { font: "sansBold", size: 15, leading: 19, before: 22, after: 6, color: "#111111", rule: true },
  { font: "sansSemibold", size: 12.5, leading: 16, before: 14, after: 4, color: "#161616" },
  { font: "sansSemibold", size: 11, leading: 14, before: 10, after: 3, color: "#1d1d1d" },
  { font: "sansSemibold", size: 10, leading: 13, before: 8, after: 2, color: "#333333" },
];
const PAGE_LABEL = { font: "sans", size: 8.5, leading: 11, before: 6, after: 3, color: MUTED };
const ITEM = { font: "serif", size: 10.5, leading: 14.5, after: 8, color: INK };
const NOTE = { font: "sans", size: 9.5, leading: 13, color: "#333333" };
const NOTE_LABEL = { font: "sansSemibold", size: 9.5, color: "#333333" };

export async function renderSummaryPdf({ PDFLib, fontkit, fonts: fontBytes, summary, reference, sourceName }) {
  const { PDFDocument, rgb } = PDFLib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = {};
  for (const [key, bytes] of Object.entries(fontBytes)) fonts[key] = await doc.embedFont(bytes, { subset: !key.startsWith("sans") });

  const color = (hex) => {
    const h = (hex || "#888888").replace("#", "");
    return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  };

  // ------------------------------------------------------------ text layout
  const widthCache = new Map();
  const measure = (text, fontKey, size) => {
    const k = fontKey + "|" + size + "|" + text;
    let w = widthCache.get(k);
    if (w === undefined) {
      w = fonts[fontKey].widthOfTextAtSize(text, size);
      widthCache.set(k, w);
    }
    return w;
  };

  /**
   * Wraps styled runs into lines no wider than maxWidth. "\n" forces a break,
   * and wrapped lines of a "• " or "1. " list item hang under the item's text.
   */
  function layout(runs, maxWidth) {
    const lines = [];
    let line = [];
    let x = 0;
    let hang = 0;
    const flush = () => {
      while (line.length && !line[line.length - 1].text.trim()) {
        x -= line[line.length - 1].width;
        line.pop();
      }
      const indent = lines.length && hang && !line.isFirst ? hang : 0;
      lines.push({ pieces: line, width: x, indent });
      line = [];
      x = 0;
    };
    for (const run of runs) {
      const paragraphs = sanitize(run.text).split("\n");
      paragraphs.forEach((para, pi) => {
        if (pi > 0) flush();
        const marker = para.match(/^(•|\d{1,2}[.)])\s/);
        if (pi > 0 || run === runs[0]) {
          hang = marker ? measure(marker[0], run.font, run.size) : 0;
          line.isFirst = true;
        }
        for (const token of para.split(/(\s+)/)) {
          if (!token) continue;
          const isSpace = !token.trim();
          if (isSpace && !line.length) continue;
          const text = isSpace ? " " : token;
          const width = measure(text, run.font, run.size);
          if (!isSpace && x + width > maxWidth - (line.isFirst ? 0 : hang) && line.length) flush();
          if (!isSpace && width > maxWidth) {
            // A single word wider than the column (a long URL): break it by characters.
            let chunk = "";
            for (const ch of text) {
              if (measure(chunk + ch, run.font, run.size) > maxWidth && chunk) {
                line.push({ ...run, text: chunk, width: measure(chunk, run.font, run.size), x });
                flush();
                chunk = "";
              }
              chunk += ch;
            }
            const w = measure(chunk, run.font, run.size);
            line.push({ ...run, text: chunk, width: w, x });
            x += w;
            continue;
          }
          line.push({ ...run, text, width, x });
          x += width;
        }
      });
    }
    if (line.length) flush();
    return lines;
  }

  // ------------------------------------------------------------- pagination
  const pages = [];
  let page = null;
  let y = 0;
  let currentChapter = "";

  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    pages.push({ page, chapter: null });
    y = PAGE.height - MARGIN.top;
  };
  const markChapter = () => {
    const p = pages[pages.length - 1];
    if (p.chapter === null) p.chapter = currentChapter;
  };
  const room = () => y - MARGIN.bottom;
  const ensure = (height) => {
    if (room() < height) newPage();
  };

  const drawLine = (ln, x, baseline) => {
    for (const piece of ln.pieces) {
      if (!piece.text.trim()) continue;
      page.drawText(piece.text, { x: x + ln.indent + piece.x, y: baseline, size: piece.size, font: fonts[piece.font], color: color(piece.color) });
    }
  };

  const drawBlock = (lines, x, style, { bar, strike } = {}) => {
    let barTop = null;
    for (let i = 0; i < lines.length; i++) {
      const remaining = lines.length - i;
      // Keep at least two lines together at the bottom of a page.
      const need = remaining === 2 || (i === 0 && remaining > 1) ? style.leading * 2 : style.leading;
      if (room() < need) {
        if (bar && barTop !== null) drawBar(bar, x, barTop, y, style);
        newPage();
        barTop = null;
      }
      markChapter();
      if (barTop === null) barTop = y;
      const baseline = y - style.size;
      drawLine(lines[i], x, baseline);
      if (strike) {
        page.drawLine({ start: { x: x + lines[i].indent, y: baseline + style.size * 0.3 }, end: { x: x + lines[i].indent + lines[i].width, y: baseline + style.size * 0.3 }, thickness: 0.7, color: color(INK) });
      }
      y -= style.leading;
    }
    if (bar && barTop !== null) drawBar(bar, x, barTop, y, style);
  };

  // The bar runs from the cap height of the first line to just below the last baseline.
  const drawBar = (hex, textX, top, bottom, style) => {
    const barTop = top - style.size * 0.22;
    const barBottom = bottom + style.leading - style.size * 1.22;
    page.drawRectangle({ x: textX - 11, y: barBottom, width: 3, height: barTop - barBottom, color: color(hex) });
  };

  const indentFor = (depth) => Math.min(depth, MAX_INDENT_LEVELS) * INDENT_STEP;

  // ------------------------------------------------------------- title block
  newPage();
  markChapter();
  const kicker = layout([{ text: "HIGHLIGHTS & NOTES", font: "sansSemibold", size: 8.5, color: MUTED }], CONTENT_WIDTH);
  drawBlock(kicker, MARGIN.left, { size: 8.5, leading: 14 });
  y -= 4;

  // APA reference with a hanging indent.
  const refRuns = parseItalics(reference.apa).map((r) => ({ text: r.text, font: r.italic ? "serifItalic" : "serif", size: 12, color: INK }));
  const hang = 36;
  const firstLine = layout(refRuns, CONTENT_WIDTH);
  if (firstLine.length > 1) {
    // Re-wrap everything after the first line at the indented width.
    const first = layout(refRuns, CONTENT_WIDTH)[0];
    const consumed = first.pieces.map((p) => p.text).join("");
    const rest = layout(sliceRuns(refRuns, consumed.length), CONTENT_WIDTH - hang);
    drawBlock([first], MARGIN.left, { size: 12, leading: 16.5 });
    drawBlock(rest, MARGIN.left + hang, { size: 12, leading: 16.5 });
  } else {
    drawBlock(firstLine, MARGIN.left, { size: 12, leading: 16.5 });
  }
  y -= 6;

  const s = summary.stats;
  const facts = [`${s.entries} highlight${s.entries === 1 ? "" : "s"}`, `${s.notes} note${s.notes === 1 ? "" : "s"}`];
  if (sourceName) facts.push(`from “${sourceName}”`);
  drawBlock(layout([{ text: facts.join("  ·  "), font: "sans", size: 9, color: MUTED }], CONTENT_WIDTH), MARGIN.left, { size: 9, leading: 12 });
  y -= 8;
  page.drawLine({ start: { x: MARGIN.left, y }, end: { x: PAGE.width - MARGIN.right, y }, thickness: 0.8, color: color(RULE) });
  y -= 6;

  // ------------------------------------------------------------- body
  const bookmarks = [];

  if (!summary.tree.length) {
    y -= 20;
    drawBlock(layout([{ text: "No highlights or notes were found in this PDF.", font: "serifItalic", size: 11, color: MUTED }], CONTENT_WIDTH), MARGIN.left, { size: 11, leading: 15 });
  }

  const drawNode = (node, depth) => {
    if (node.type === "heading") {
      const st = HEADING_STYLES[Math.min(depth, HEADING_STYLES.length - 1)];
      const x = MARGIN.left + indentFor(depth);
      const lines = layout([{ text: node.title, font: st.font, size: st.size, color: st.color }], PAGE.width - MARGIN.right - x);
      ensure(st.before + lines.length * st.leading + st.after + 48);
      if (y < PAGE.height - MARGIN.top - 1) y -= st.before;
      if (depth === 0) currentChapter = node.title;
      bookmarks.push({ title: node.title, depth, pageIndex: pages.length - 1, y: Math.min(PAGE.height, y + 4) });
      drawBlock(lines, x, st, { bar: node.mark?.color });
      if (st.rule) {
        page.drawLine({ start: { x, y: y - 2 }, end: { x: PAGE.width - MARGIN.right, y: y - 2 }, thickness: 0.6, color: color(RULE) });
        y -= 3;
      }
      y -= st.after;
      if (node.mark?.note) drawNote(node.mark.note, x + INDENT_STEP);
      for (const child of node.children) drawNode(child, depth + 1);
      return;
    }

    // A group of highlights from one page (or a page range for merged highlights).
    const x = MARGIN.left + indentFor(depth);
    const label = pageLabel(node);
    const labelLines = layout([{ text: label, font: PAGE_LABEL.font, size: PAGE_LABEL.size, color: PAGE_LABEL.color }], CONTENT_WIDTH);
    ensure(PAGE_LABEL.before + PAGE_LABEL.leading + ITEM.leading * 2);
    y -= PAGE_LABEL.before;
    drawBlock(labelLines, x, PAGE_LABEL);
    y -= PAGE_LABEL.after;

    const textX = x + 11;
    const width = PAGE.width - MARGIN.right - textX;
    for (const item of node.items) {
      if (item.text) {
        const lines = layout([{ text: item.text, font: ITEM.font, size: ITEM.size, color: ITEM.color }], width);
        drawBlock(lines, textX, ITEM, { bar: item.color, strike: item.type === "StrikeOut" });
      }
      if (item.note) drawNote(item.note, textX, !item.text ? item.color : null);
      y -= ITEM.after;
    }
  };

  const drawNote = (note, x, bar) => {
    y -= 1;
    const runs = [
      { text: "Note: ", font: NOTE_LABEL.font, size: NOTE_LABEL.size, color: NOTE_LABEL.color },
      { text: note, font: NOTE.font, size: NOTE.size, color: NOTE.color },
    ];
    const lines = layout(runs, PAGE.width - MARGIN.right - x);
    drawBlock(lines, x, NOTE, { bar });
    y -= 2;
  };

  for (const node of summary.tree) drawNode(node, 0);

  // ---------------------------------------------- running heads and folios
  const shortCite = reference.fileName.replace(/\)\s.*$/, ")");
  pages.forEach(({ page: p, chapter }, i) => {
    const folio = String(i + 1);
    const fw = measure(folio, "sans", 8.5);
    p.drawText(folio, { x: (PAGE.width - fw) / 2, y: 30, size: 8.5, font: fonts.sans, color: color(MUTED) });
    if (i === 0) return;
    const head = truncate(chapter || "", "sans", 8, CONTENT_WIDTH * 0.7);
    if (head) p.drawText(head, { x: MARGIN.left, y: PAGE.height - 40, size: 8, font: fonts.sans, color: color(MUTED) });
    const cite = truncate(shortCite, "sans", 8, CONTENT_WIDTH * 0.28);
    p.drawText(cite, { x: PAGE.width - MARGIN.right - measure(cite, "sans", 8), y: PAGE.height - 40, size: 8, font: fonts.sans, color: color(MUTED) });
    p.drawLine({ start: { x: MARGIN.left, y: PAGE.height - 46 }, end: { x: PAGE.width - MARGIN.right, y: PAGE.height - 46 }, thickness: 0.5, color: color(RULE) });
  });

  function truncate(text, font, size, max) {
    const t = sanitize(text);
    if (measure(t, font, size) <= max) return t;
    let out = t;
    while (out.length > 1 && measure(out + "…", font, size) > max) out = out.slice(0, -1);
    return out.trimEnd() + "…";
  }

  addBookmarks(PDFLib, doc, pages.map((p) => p.page), bookmarks);
  doc.setTitle(`${reference.fileName} — highlights & notes`, { showInWindowTitleBar: true });
  doc.setSubject(reference.apa.replace(/\*/g, ""));
  doc.setCreator("PDF Highlight Summary");
  doc.setProducer("pdf-lib");
  return doc.save();
}

export function pageLabel(group) {
  const pdf = group.pdfFrom === group.pdfTo ? `${group.pdfFrom}` : `${group.pdfFrom}–${group.pdfTo}`;
  if (!group.labelFrom) return `PDF ${pdf}`;
  const printed = group.labelFrom === group.labelTo || !group.labelTo ? group.labelFrom : `${group.labelFrom}–${group.labelTo}`;
  return `PDF ${pdf}  |  Actual ${printed}`;
}

/** "*Title* (10th ed.)" -> [{text: "Title", italic: true}, {text: " (10th ed.)"}] */
export function parseItalics(text) {
  const runs = [];
  const re = /\*([^*]+)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), italic: false });
    runs.push({ text: m[1], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), italic: false });
  return runs;
}

function sliceRuns(runs, chars) {
  const out = [];
  let skip = chars;
  for (const r of runs) {
    const text = sanitize(r.text);
    if (skip >= text.length) {
      skip -= text.length;
      continue;
    }
    out.push({ ...r, text: text.slice(skip) });
    skip = 0;
  }
  if (out.length) out[0].text = out[0].text.replace(/^\s+/, "");
  return out;
}

/** Characters pdf-lib cannot draw (control codes, tabs) are replaced. */
function sanitize(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "");
}

/** Builds the PDF outline (bookmarks) from the headings, nested by depth. */
function addBookmarks(PDFLib, doc, pages, entries) {
  if (!entries.length) return;
  const { PDFName, PDFHexString, PDFNumber, PDFNull } = PDFLib;
  const ctx = doc.context;
  const root = { children: [] };
  const stack = [root];
  for (const e of entries) {
    const node = { ...e, children: [] };
    while (stack.length > e.depth + 1) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  const build = (nodes, parentRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    nodes.forEach((n, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of("Title"), PDFHexString.fromText(n.title));
      dict.set(PDFName.of("Parent"), parentRef);
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < nodes.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      dict.set(PDFName.of("Dest"), ctx.obj([pages[n.pageIndex].ref, PDFName.of("XYZ"), PDFNull, PDFNumber.of(Math.round(n.y)), PDFNull]));
      if (n.children.length) {
        const sub = build(n.children, refs[i]);
        dict.set(PDFName.of("First"), sub.first);
        dict.set(PDFName.of("Last"), sub.last);
        dict.set(PDFName.of("Count"), PDFNumber.of(-n.children.length));
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const outlinesRef = ctx.nextRef();
  const top = build(root.children, outlinesRef);
  const outlines = ctx.obj({});
  outlines.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlines.set(PDFName.of("First"), top.first);
  outlines.set(PDFName.of("Last"), top.last);
  outlines.set(PDFName.of("Count"), PDFNumber.of(root.children.length));
  ctx.assign(outlinesRef, outlines);
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}
