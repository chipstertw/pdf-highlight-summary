// Reads everything the summary needs from a PDF with MuPDF: each text line with
// its font styles, each highlight-type annotation with the characters under it,
// standalone notes, bookmarks, page labels and document metadata.
//
// Works the same in a browser worker and in Node; the caller passes in the
// MuPDF module so this file has no environment-specific imports.

const MARKUP_TYPES = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
const NOTE_TYPES = new Set(["Text", "FreeText"]);
const SYMBOL_FONT = /dingbat|wingding|webding|symbol|zapf|marlett/i;
const BOLD_NAME = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/i;
const ITALIC_NAME = /italic|oblique|ita$|-it$/i;
const WHITESPACE = /\s/u;
const DASH = /[-\u2010\u2011\u2012–—]/;

export class UserFacingError extends Error {}

export function readPdf(mupdf, data, onProgress) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(data, "application/pdf");
  } catch {
    throw new UserFacingError("This file could not be opened as a PDF.");
  }
  try {
    if (doc.needsPassword()) {
      throw new UserFacingError("This PDF is password-protected. Open it in Preview, export a copy without a password, and try again.");
    }
    const pdf = doc.asPDF();
    if (!pdf) throw new UserFacingError("This file could not be opened as a PDF.");
    const pageCount = doc.countPages();
    if (!pageCount) throw new UserFacingError("This PDF has no pages.");
    const hasPageLabels = !pdf.getTrailer().get("Root").get("PageLabels").isNull();

    const meta = {};
    for (const [key, field] of [["title", "info:Title"], ["author", "info:Author"], ["subject", "info:Subject"], ["created", "info:CreationDate"]]) {
      meta[key] = (doc.getMetaData(field) || "").trim();
    }

    const outline = [];
    flattenOutline(doc.loadOutline() || [], 1, outline);

    const fonts = new Map();
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        pages.push(readPage(page, i, hasPageLabels, fonts));
      } finally {
        page.destroy();
      }
      if (onProgress && (i % 8 === 7 || i === pageCount - 1)) onProgress(i + 1, pageCount);
    }
    return { pageCount, meta, outline, hasPageLabels, pages };
  } finally {
    doc.destroy();
  }
}

function flattenOutline(items, level, out) {
  for (const item of items) {
    const title = (item.title || "").replace(/\s+/g, " ").trim();
    if (title && Number.isInteger(item.page) && item.page >= 0) out.push({ title, level, page: item.page });
    if (item.down) flattenOutline(item.down, level + 1, out);
  }
}

function fontInfo(font, cache) {
  let info = cache.get(font.pointer);
  if (!info) {
    const name = font.getName().replace(/^[A-Z]{6}\+/, "");
    info = {
      id: cache.size,
      name,
      bold: font.isBold() || BOLD_NAME.test(name),
      italic: font.isItalic() || ITALIC_NAME.test(name),
      symbol: SYMBOL_FONT.test(name),
    };
    cache.set(font.pointer, info);
  }
  return info;
}

const hex = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");

function colorToHex(color) {
  if (!color || !color.length) return "#888888";
  if (color.length === 1) return "#" + hex(color[0]).repeat(3);
  if (color.length === 4) {
    const [c, m, y, k] = color;
    return "#" + hex((1 - c) * (1 - k)) + hex((1 - m) * (1 - k)) + hex((1 - y) * (1 - k));
  }
  return "#" + hex(color[0]) + hex(color[1]) + hex(color[2]);
}

function quadBox(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box[2] - box[0] > 0.5 && box[3] - box[1] > 0.5 ? box : null;
}

function readPage(page, index, hasPageLabels, fonts) {
  const bounds = page.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];

  const marks = [];
  const notes = [];
  for (const annot of page.getAnnotations()) {
    const type = annot.getType();
    if (MARKUP_TYPES.has(type)) {
      const quads = annot.getQuadPoints().map(quadBox).filter(Boolean);
      if (!quads.length) continue;
      marks.push({
        type,
        color: colorToHex(annot.getColor()),
        note: annot.getContents() || "",
        quads,
        frags: [],
        cur: null,
        prevIn: -1,
        x: quads[0][0],
        y: quads[0][1],
      });
    } else if (NOTE_TYPES.has(type)) {
      const note = annot.getContents() || "";
      if (note.trim()) {
        const r = annot.getBounds();
        notes.push({ type, color: colorToHex(annot.getColor()), note, x: r[0], y: r[1] });
      }
    }
  }

  const lines = [];
  let line = null;
  let span = null;
  let block = -1;
  let n = -1;
  let wordIdx = 0; // counts non-space characters in content order

  const stext = page.toStructuredText("preserve-whitespace");
  try {
    stext.walk({
      beginTextBlock() {
        block++;
      },
      beginLine(bbox) {
        n++;
        line = { n, block, x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3], spans: [], c0: wordIdx, c1: wordIdx - 1, text: "", bullet: false };
        span = null;
      },
      onChar(c, origin, font, size, quad, color) {
        if (!line) return;
        const f = fontInfo(font, fonts);
        const code = c.codePointAt(0);
        if (f.symbol || (code >= 0xe000 && code <= 0xf8ff)) {
          // A symbol glyph before any text is a list bullet.
          if (!line.spans.some((s) => s.text.trim())) line.bullet = true;
          return;
        }

        const isWord = !WHITESPACE.test(c) && !DASH.test(c);
        const idx = isWord ? wordIdx++ : -1;
        if (isWord) line.c1 = idx;

        const colorHex = colorToHex(color);
        const key = f.id + "|" + size.toFixed(1) + "|" + colorHex;
        if (!span || span.key !== key) {
          span = { key, text: "", font: f.name, size: Math.round(size * 10) / 10, color: colorHex, bold: f.bold, italic: f.italic, x0: quad[0], x1: quad[2] };
          line.spans.push(span);
        }
        span.text += c;
        span.x1 = Math.max(span.x1, quad[2], quad[6]);

        if (marks.length) {
          for (const m of marks) {
            const hit = underMark(m.quads, quad);
            // The edge rule only extends a word the highlight already covers.
            const extendsWord = m.prevIn === line.n;
            m.prevIn = (hit === "inside" || (hit === "edge" && extendsWord)) && !WHITESPACE.test(c) ? line.n : -1;
            if (!hit || (hit === "edge" && !extendsWord)) continue;
            if (!m.cur || m.cur.n !== line.n) {
              m.cur = { n: line.n, text: "", i0: null, i1: null, x: quad[0] };
              m.frags.push(m.cur);
            }
            m.cur.text += c;
            if (isWord) {
              if (m.cur.i0 === null) m.cur.i0 = idx;
              m.cur.i1 = idx;
            }
          }
        }
      },
      endLine() {
        if (line) {
          line.text = line.spans.map((s) => s.text).join("");
          if (line.text.trim()) {
            for (const s of line.spans) delete s.key;
            lines.push(line);
          }
        }
        line = null;
      },
    });
  } finally {
    stext.destroy();
  }

  for (const m of marks) {
    delete m.cur;
    delete m.quads;
    delete m.prevIn;
  }

  return {
    index,
    label: hasPageLabels ? page.getLabel() || "" : "",
    width,
    height,
    lines,
    marks,
    notes,
  };
}

/**
 * A character belongs to a highlight when its centre is inside one of the
 * highlight's boxes. Preview (PDFKit) often ends a box where the last selected
 * character begins rather than where it ends, so a character that starts right
 * at a box's right edge counts too when it continues a covered word; otherwise
 * "process" would come out as "proces".
 */
function underMark(boxes, quad) {
  const x0 = Math.min(quad[0], quad[4]);
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  for (const b of boxes) {
    if (cy < b[1] || cy > b[3]) continue;
    if (cx >= b[0] - 0.5 && cx <= b[2] + 0.5) return "inside";
    if (Math.abs(x0 - b[2]) <= 0.6) return "edge";
  }
  return null;
}
