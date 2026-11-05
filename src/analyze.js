// Turns what read-pdf.js extracted into the summary tree:
//   heading > sub-heading > ... > page > highlight (+ note)
//
// Everything here is rule-based, so the same PDF always gives the same summary.
//
// Headings come from two places:
//   1. the PDF's bookmarks (exact, but usually only chapters and main sections);
//   2. the page itself: lines set in a heading style (bigger or bold type), plus
//      bold "run-in" headings that start a paragraph. Styles are ranked by
//      prominence to decide how deep each heading nests, and lined up with the
//      bookmark levels when both exist.

import { cleanText, cleanNote, norm, collapseLetterSpacing, buildWordSet, joinLines, tidyHighlight, endsSentence } from "./text.js";
import { numberParagraphs, paragraphLocator } from "./paragraphs.js";

const TAG = /^[A-Z]{1,4}\s?\d{1,3}[a-z]?$/; // margin tags such as "LO1"
const CAPTION = /^(table|figure|fig|exhibit|chart|box|plate|photo)\.?\s*[\dIVX]/i;
const LIST_MARKER = /^(\(?\d{1,2}[.)]|\(?[a-z][.)]|[•●▪■–—-])\s/;
const PAGE_NUMBER = /^\s*(\d{1,4}|[ivxlcdm]{1,8})\s*$/i;
const letterCount = (s) => (s.match(/\p{L}/gu) || []).length;
const family = (font) => font.replace(/[-,].*$/, "").replace(/(MT|PS)$/, "");

export function analyze(raw) {
  const pages = raw.pages;
  const body = findBodyStyle(pages);
  for (const page of pages) for (const line of page.lines) describeLine(line, body);
  markFurniture(pages, body);

  const words = buildWordSet(pages);
  const labels = raw.hasPageLabels ? pages.map((p) => p.label) : detectPrintedPageNumbers(pages);
  const columns = pages.map((p) => detectColumns(p, body));

  const headings = findHeadings(raw, body, words);
  const { marks, empty } = collectMarks(pages, words);
  const events = [...headings, ...marks];
  sortEvents(events, columns);

  attachHeadingHighlights(events);
  const merged = mergeContinuations(events, pages, words);

  // Pages without a printed page number get APA paragraph locators instead.
  const needsParagraphs = marks.some((m) => !m.drop && !labels[m.page]);
  const paraAt = needsParagraphs ? numberParagraphs(pages, body, columns, headings) : null;
  const tree = buildTree(events, labels, paraAt);

  const items = marks.filter((m) => !m.drop);
  const headingMarks = headings.filter((h) => h.mark);
  return {
    tree,
    stats: {
      pages: pages.length,
      highlights: marks.filter((m) => m.type !== "Note").length,
      entries: items.length,
      notes: items.filter((m) => m.note).length + headingMarks.filter((h) => h.mark.note).length,
      merged,
      headingHighlights: headingMarks.length,
      emptyHighlights: empty,
      usedBookmarks: headings.some((h) => h.source === "outline"),
      paragraphLocators: needsParagraphs ? items.filter((m) => !labels[m.page]).length : 0,
    },
  };
}

// ---------------------------------------------------------------- page model

function findBodyStyle(pages) {
  const counts = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      for (const s of line.spans) {
        const key = s.font + "|" + Math.round(s.size * 2) / 2;
        counts.set(key, (counts.get(key) || 0) + letterCount(s.text));
      }
    }
  }
  let best = null;
  let bestCount = -1;
  for (const [key, c] of counts) {
    if (c > bestCount) {
      best = key;
      bestCount = c;
    }
  }
  if (!best) return { font: "", size: 10 };
  const i = best.lastIndexOf("|");
  return { font: best.slice(0, i), size: Number(best.slice(i + 1)) };
}

function describeLine(line, body) {
  let letters = 0;
  let bold = 0;
  let dominant = null;
  let dominantLetters = -1;
  for (const s of line.spans) {
    const n = letterCount(s.text);
    s.letters = n;
    letters += n;
    if (s.bold) bold += n;
    if (n > dominantLetters) {
      dominant = s;
      dominantLetters = n;
    }
  }
  const style = dominant || line.spans[0];
  let sameSize = 0;
  for (const s of line.spans) if (Math.abs(s.size - style.size) < 0.3) sameSize += s.letters;
  line.letters = letters;
  line.boldLetters = bold;
  line.sameSizeLetters = sameSize;
  line.style = { font: style.font, size: style.size, color: style.color, bold: style.bold, key: `${style.font}|${Math.round(style.size * 2) / 2}|${style.color}` };
  line.isBody = style.font === body.font && Math.abs(style.size - body.size) < 0.3;
}

/**
 * Running heads, running feet and page numbers: never headings, never part of a
 * highlight. A line counts when it sits above or below the usual text area and
 * the same words (ignoring numbers) recur on several pages.
 */
function markFurniture(pages, body) {
  const tops = [];
  const bottoms = [];
  for (const page of pages) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const line of page.lines) {
      if (!line.isBody) continue;
      top = Math.min(top, line.y0 / page.height);
      bottom = Math.max(bottom, line.y1 / page.height);
    }
    if (top < Infinity) {
      tops.push(top);
      bottoms.push(bottom);
    }
  }
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const top = tops.length ? median(tops) : 0;
  const bottom = bottoms.length ? median(bottoms) : 1;

  const key = (text) => cleanText(text).toLowerCase().replace(/\b([ivxlcdm]+|\d+)\b/g, " ").replace(/[^\p{L}]+/gu, " ").trim();
  const inMargin = (line, page) =>
    line.style.size < body.size * 1.4 && (line.y1 / page.height <= top + 0.002 || line.y0 / page.height >= bottom - 0.002);

  const seen = new Map();
  for (const page of pages) {
    for (const k of new Set(page.lines.filter((l) => inMargin(l, page)).map((l) => key(l.text)))) {
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  const minRepeat = Math.min(3, Math.max(2, Math.ceil(pages.length / 3)));
  for (const page of pages) {
    for (const line of page.lines) {
      const k = key(line.text);
      line.furniture = PAGE_NUMBER.test(line.text) || (inMargin(line, page) && (!k || seen.get(k) >= minRepeat));
    }
  }
}

/** Printed page numbers for PDFs without page labels, read from running heads and feet. */
function detectPrintedPageNumbers(pages) {
  const found = pages.map((page) => {
    const nums = new Set();
    for (const line of page.lines) {
      if (!line.furniture) continue;
      const t = cleanText(line.text).trim();
      const lead = t.match(/^(\d{1,4})(?:\s|$)/);
      const trail = t.match(/(?:^|\s)(\d{1,4})$/);
      if (lead) nums.add(Number(lead[1]));
      if (trail) nums.add(Number(trail[1]));
    }
    return [...nums];
  });
  return pages.map((_, i) => {
    const votes = new Map();
    for (let j = Math.max(0, i - 10); j <= Math.min(pages.length - 1, i + 10); j++) {
      for (const v of found[j]) votes.set(v - j, (votes.get(v - j) || 0) + 1);
    }
    let best = null;
    let bestVotes = 0;
    for (const [offset, v] of votes) {
      const own = found[i].includes(i + offset);
      if (v > bestVotes || (v === bestVotes && own && !found[i].includes(i + best))) {
        best = offset;
        bestVotes = v;
      }
    }
    if (bestVotes < 2 || i + best < 1) return "";
    return String(i + best);
  });
}

/** Two-column pages are read left column first. */
function detectColumns(page, body) {
  const lines = page.lines.filter((l) => !l.furniture && Math.abs(l.style.size - body.size) < 0.8 && l.letters > 10);
  if (lines.length < 12) return null;
  const w = page.width;
  const left = lines.filter((l) => l.x1 < w * 0.55);
  const right = lines.filter((l) => l.x0 > w * 0.45);
  const crossing = lines.length - left.length - right.length;
  if (left.length < lines.length * 0.25 || right.length < lines.length * 0.25 || crossing > lines.length * 0.15) return null;
  const leftEdge = Math.max(...left.map((l) => l.x1));
  const rightEdge = Math.min(...right.map((l) => l.x0));
  return leftEdge < rightEdge ? { mid: (leftEdge + rightEdge) / 2 } : null;
}

// ------------------------------------------------------------------ headings

function standaloneStyle(line, body) {
  if (line.letters < 2) return null;
  const t = line.text.trim();
  if (TAG.test(t)) return null;
  const s = line.style;
  if (s.size >= body.size * 1.12 && line.sameSizeLetters / line.letters >= 0.8) return s;
  if (s.bold && line.boldLetters / line.letters >= 0.9 && s.size >= body.size - 0.6 && line.letters <= 90) return s;
  return null;
}

function runInHeading(line, body, prev) {
  const spans = line.spans;
  let i = 0;
  while (i < spans.length && !spans[i].text.trim()) i++;
  const first = spans[i];
  if (!first || !first.bold) return null;
  let j = i;
  let boldText = "";
  // The heading is the bold run in the heading's own typeface; a bold key term that
  // opens the paragraph right after it ("Congruence implies ...") is not part of it.
  const sameFace = (s) => s.bold && s.font === first.font && Math.abs(s.size - first.size) < 0.3;
  while (j < spans.length && (sameFace(spans[j]) || !spans[j].text.trim())) boldText += spans[j++].text;
  const rest = spans.slice(j);
  if (!rest.some((s) => !s.bold && s.letters > 0 && Math.abs(s.size - body.size) < 0.8)) return null;

  const title = cleanText(boldText).trim().replace(/[\s.:–—-]+$/, "");
  if (title.length < 3 || title.length > 90 || title.split(" ").length > 12) return null;
  if (!/^[\p{Lu}\d]/u.test(title)) return null;

  const after = (boldText.match(/\s*$/)[0] + rest.map((s) => s.text).join("")).slice(0, 3);
  const punct = /[.:–—]$/.test(boldText.trim());
  const wideGap = /^\s*[\u2000-\u200A]/.test(after) || /^\s{2,}/.test(after);
  const otherTypeface = family(first.font) !== family(body.font) && /^\s/.test(after);
  if (!punct && !wideGap && !otherTypeface) return null;

  const startsParagraph = !prev || prev.block !== line.block || endsSentence(prev.text) || line.x0 > prev.x0 + 2;
  if (!startsParagraph) return null;
  return { title, key: `${first.font}|${Math.round(first.size * 2) / 2}|${first.color}|run-in`, size: first.size, bold: true };
}

function findHeadings(raw, body, words) {
  const blocks = [];
  const runIns = [];
  for (const page of raw.pages) {
    let prev = null;
    let open = null;
    for (const line of page.lines) {
      if (line.furniture) continue;
      const st = standaloneStyle(line, body);
      if (st) {
        const continues =
          open &&
          open.key === st.key &&
          prev === open.last &&
          (line.block === open.last.block || line.y0 - open.last.y1 <= st.size * 0.8) &&
          line.x0 < open.last.x1 &&
          line.x1 > open.last.x0;
        if (continues) {
          open.lines.push(line);
          open.last = line;
        } else {
          open = { page: page.index, key: st.key, size: st.size, bold: st.bold, lines: [line], last: line };
          blocks.push(open);
        }
      } else {
        open = null;
        const r = runInHeading(line, body, prev);
        if (r) runIns.push({ page: page.index, line, ...r });
      }
      prev = line;
    }
  }

  for (const b of blocks) {
    b.title = collapseLetterSpacing(joinLines(b.lines.map((l) => cleanText(l.text)), words)).trim();
    b.y0 = b.lines[0].y0;
    b.y1 = b.last.y1;
    b.x0 = Math.min(...b.lines.map((l) => l.x0));
    const wordsIn = b.title.split(" ").length;
    b.ok =
      letterCount(b.title) >= 2 &&
      b.title.length <= 200 &&
      b.lines.length <= 5 &&
      !CAPTION.test(b.title) &&
      !(endsSentence(b.title) && wordsIn > 8);
  }

  // A heading style is one whose lines read like headings: short, not sentences, not list items.
  const styles = new Map();
  for (const b of blocks) {
    if (!b.ok) continue;
    if (!styles.has(b.key)) styles.set(b.key, { key: b.key, size: b.size, bold: b.bold, blocks: [] });
    styles.get(b.key).blocks.push(b);
  }
  // A line set in a run-in heading style that fills its own line is the same level as the run-ins.
  const runInKeys = new Set(runIns.map((r) => r.key));
  const asRunIn = (key) => (runInKeys.has(key + "|run-in") ? key + "|run-in" : null);
  const accepted = [];
  for (const s of styles.values()) {
    if (asRunIn(s.key)) continue;
    const n = s.blocks.length;
    const sentences = s.blocks.filter((b) => /[.;,]$/.test(b.title)).length / n;
    const lists = s.blocks.filter((b) => LIST_MARKER.test(b.title)).length / n;
    const lengths = s.blocks.map((b) => b.title.length).sort((a, b) => a - b);
    if (sentences > 0.5 || lists > 0.5 || lengths[Math.floor(n / 2)] > 110) continue;
    accepted.push(s);
  }
  accepted.sort((a, b) => b.size - a.size || Number(b.bold) - Number(a.bold) || a.blocks.length - b.blocks.length || (a.key < b.key ? -1 : 1));
  const rank = new Map(accepted.map((s, i) => [s.key, i]));

  const runInStyles = [...new Set(runIns.map((r) => r.key))]
    .map((key) => ({ key, size: runIns.find((r) => r.key === key).size }))
    .sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : 1));
  runInStyles.forEach((s, i) => rank.set(s.key, accepted.length + i));

  const outline = usableOutline(raw.outline);
  const events = [];
  const consumed = new Set();
  const depthRanks = new Map();

  outline.forEach((entry, seq) => {
    const prevEvent = events[events.length - 1];
    const hit = locateTitle(entry.title, entry.page, raw.pages, blocks, prevEvent);
    const ev = { kind: "heading", source: "outline", level: entry.level, title: entry.title, page: entry.page, y: -1, x: 0, seq };
    if (hit) {
      Object.assign(ev, { page: hit.page, y: hit.y0, y1: hit.y1, x: hit.x0, match: hit.text });
      if (hit.block) {
        consumed.add(hit.block);
        if (rank.has(hit.block.key)) {
          if (!depthRanks.has(entry.level)) depthRanks.set(entry.level, new Map());
          const m = depthRanks.get(entry.level);
          const r = rank.get(hit.block.key);
          m.set(r, (m.get(r) || 0) + 1);
        }
      }
    } else if (prevEvent && prevEvent.page === entry.page) {
      ev.y = prevEvent.y + 0.001;
      ev.x = prevEvent.x;
    }
    events.push(ev);
  });

  const levelFor = levelMapper(depthRanks, outline.length > 0);

  for (const b of blocks) {
    const key = rank.has(b.key) ? b.key : asRunIn(b.key);
    if (!b.ok || consumed.has(b) || !key) continue;
    const level = levelFor(rank.get(key));
    if (level === null) continue;
    let title = b.title;
    if (!outline.length && rank.get(key) === 0) title = withChapterNumber(title, raw.pages[b.page], b);
    events.push({ kind: "heading", source: "page", level, title, match: b.title, page: b.page, y: b.y0, y1: b.y1, x: b.x0, seq: 0 });
  }
  for (const r of runIns) {
    const level = levelFor(rank.get(r.key));
    if (level === null) continue;
    events.push({ kind: "heading", source: "run-in", level, title: r.title, match: r.title, page: r.page, y: r.line.y0, y1: r.line.y1, x: r.line.x0, seq: 0 });
  }
  return events;
}

/** Bookmarks are ignored when they are just "Page 1, Page 2, ...". */
function usableOutline(outline) {
  if (!outline || outline.length < 2) return [];
  const junk = outline.filter((e) => /^(page|p\.)?\s*\d+$/i.test(e.title)).length;
  return junk > outline.length / 2 ? [] : outline;
}

/**
 * Maps a heading-style rank to a nesting level. Styles that match bookmark
 * levels take that level; others slot in between or below. Levels can be
 * fractional: only their order matters.
 */
function levelMapper(depthRanks, hasOutline) {
  const mapped = [];
  for (const depth of [...depthRanks.keys()].sort((a, b) => a - b)) {
    let best = null;
    let bestCount = -1;
    for (const [r, c] of depthRanks.get(depth)) {
      if (c > bestCount || (c === bestCount && r < best)) {
        best = r;
        bestCount = c;
      }
    }
    if (!mapped.length || best > mapped[mapped.length - 1].rank) mapped.push({ depth, rank: best });
  }
  return (rank) => {
    if (!mapped.length) return hasOutline ? 100 + rank : rank + 1;
    const exact = mapped.find((m) => m.rank === rank);
    if (exact) return exact.depth;
    const above = [...mapped].reverse().find((m) => m.rank < rank);
    const below = mapped.find((m) => m.rank > rank);
    if (!above) return null;
    if (!below) return above.depth + (rank - above.rank);
    return above.depth + ((rank - above.rank) / (below.rank - above.rank)) * (below.depth - above.depth);
  };
}

function titleMatches(candidate, title) {
  const a = norm(candidate);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a) && a.length >= b.length * 0.6) return true;
  if (b.length >= 4 && a.includes(b) && b.length >= a.length * 0.6) return true;
  return false;
}

/** Finds where a bookmark's heading sits on its page (or the next one). */
function locateTitle(title, pageIndex, pages, blocks, prevEvent) {
  for (const p of [pageIndex, pageIndex + 1]) {
    const page = pages[p];
    if (!page) continue;
    const after = (y) => !prevEvent || prevEvent.page !== p || y > prevEvent.y;
    const block = blocks.find((b) => b.page === p && after(b.y0) && titleMatches(b.title, title));
    if (block) return { page: p, y0: block.y0, y1: block.y1, x0: block.x0, text: block.title, block };
    const lines = page.lines;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].furniture || !after(lines[i].y0)) continue;
      const one = collapseLetterSpacing(cleanText(lines[i].text).trim());
      if (titleMatches(one, title)) return { page: p, y0: lines[i].y0, y1: lines[i].y1, x0: lines[i].x0, text: one };
      if (i + 1 < lines.length) {
        const two = one + " " + collapseLetterSpacing(cleanText(lines[i + 1].text).trim());
        if (titleMatches(two, title)) return { page: p, y0: lines[i].y0, y1: lines[i + 1].y1, x0: lines[i].x0, text: two };
      }
    }
  }
  return null;
}

/** Chapter openers often print the number huge and separately ("2" above the title). */
function withChapterNumber(title, page, block) {
  const big = page.lines.find((l) => /^\s*\d{1,3}\s*$/.test(l.text) && l.style.size >= block.size * 1.2);
  return big && !/^\s*(chapter|part)\b/i.test(title) ? `Chapter ${big.text.trim()}: ${title}` : title;
}

// ---------------------------------------------------------------- highlights

function collectMarks(pages, words) {
  const marks = [];
  let empty = 0;
  for (const page of pages) {
    const lineByN = new Map(page.lines.map((l) => [l.n, l]));
    for (const m of page.marks) {
      // Running heads, page numbers and margin tags caught under a highlight are not part of it.
      const frags = m.frags.filter((f) => {
        const line = lineByN.get(f.n);
        return line && !line.furniture && !TAG.test(line.text.trim()) && f.text.trim();
      });
      const text = highlightText(frags, lineByN, words);
      let note = cleanNote(m.note);
      if (note && norm(note) === norm(text)) note = ""; // some apps store the highlighted words as the note
      if (!text && !note) {
        empty++;
        continue;
      }
      const first = frags.find((f) => f.i0 !== null);
      const last = [...frags].reverse().find((f) => f.i1 !== null);
      marks.push({
        kind: "mark",
        type: m.type,
        color: m.color,
        text,
        note,
        page: page.index,
        pageTo: page.index,
        y: first ? lineByN.get(first.n).y0 : m.y,
        x: first ? first.x : m.x,
        endY: last ? lineByN.get(last.n).y0 : m.y,
        endX: last ? last.x : m.x,
        firstIdx: first ? first.i0 : null,
        lastIdx: last ? last.i1 : null,
        seq: 0,
      });
    }
    for (const n of page.notes) {
      marks.push({ kind: "mark", type: "Note", color: n.color, text: "", note: cleanNote(n.note), page: page.index, pageTo: page.index, y: n.y, x: n.x, endY: n.y, endX: n.x, firstIdx: null, lastIdx: null, seq: 0 });
    }
  }
  return { marks, empty };
}

/** Joins a highlight's lines; list items it spans stay on separate lines with a bullet. */
function highlightText(frags, lineByN, words) {
  const items = [];
  for (const f of frags) {
    const line = lineByN.get(f.n);
    const text = cleanText(f.text);
    const startsLine = text.trim() && cleanText(line.text).trim().startsWith(text.trim().slice(0, 12));
    const listStart = startsLine && (line.bullet || /^\s*([•●▪■◦]|\d{1,2}[.)]\s)/.test(cleanText(line.text)));
    if (listStart || !items.length) items.push({ list: listStart, parts: [] });
    items[items.length - 1].parts.push(text);
  }
  const joined = items.map((it) => ({ list: it.list, text: tidyHighlight(joinLines(it.parts, words)) })).filter((it) => it.text);
  if (joined.length < 2) return joined[0]?.text || "";
  const listy = joined.filter((it) => it.list).length > 1;
  return joined.map((it) => (it.list && listy && !/^\d{1,2}[.)]/.test(it.text) ? "• " + it.text : it.text)).join("\n");
}

function sortEvents(events, columns) {
  const col = (e) => {
    const c = columns[e.page];
    return c && e.y >= 0 && e.x >= c.mid ? 1 : 0;
  };
  for (const e of events) e.col = col(e);
  events.sort(
    (a, b) =>
      a.page - b.page ||
      a.col - b.col ||
      Math.round(a.y * 100) - Math.round(b.y * 100) ||
      (a.kind === b.kind ? 0 : a.kind === "heading" ? -1 : 1) ||
      a.x - b.x ||
      a.seq - b.seq,
  );
}

/**
 * Removes the heading text from highlights that start on a heading: a highlight
 * that is only the heading becomes a marker on the heading itself; a highlight
 * that runs from the heading into the paragraph keeps just the paragraph part.
 */
function attachHeadingHighlights(events) {
  const stack = [];
  for (const ev of events) {
    if (ev.kind === "heading") {
      while (stack.length && stack[stack.length - 1].level >= ev.level) stack.pop();
      stack.push(ev);
      continue;
    }
    if (!ev.text) continue;
    for (const h of stack.slice(-2).reverse()) {
      if (h.page !== ev.page || !h.match || h.y < 0 || ev.y < h.y - 1 || ev.y > h.y1 + 1) continue;
      const rest = stripPrefix(ev.text, h.match);
      if (rest === null) continue;
      if (rest === "") {
        h.mark = h.mark ? { ...h.mark, note: [h.mark.note, ev.note].filter(Boolean).join("\n\n") } : { color: ev.color, note: ev.note, type: ev.type };
        ev.drop = true;
      } else {
        ev.text = rest;
      }
      break;
    }
  }
}

function stripPrefix(text, title) {
  const target = norm(title);
  if (!target) return null;
  let acc = "";
  for (let i = 0; i < text.length; i++) {
    acc += norm(text[i]);
    if (acc.length >= target.length) {
      if (acc !== target) return null;
      return text.slice(i + 1).replace(/^[\s.:;,–—-]+/, "");
    }
    if (!target.startsWith(acc)) return null;
  }
  return acc ? "" : null;
}

/** Highlights that are one sentence split by a page break (or two strokes) become one entry. */
function mergeContinuations(events, pages, words) {
  const flow = pages.map((page) => {
    let min = Infinity;
    let max = -Infinity;
    for (const l of page.lines) {
      if (l.furniture || !l.isBody || l.c1 < l.c0) continue;
      min = Math.min(min, l.c0);
      max = Math.max(max, l.c1);
    }
    return { min, max };
  });

  const canMerge = (a, b) => {
    if (a.type === "Note" || a.type !== b.type || a.color !== b.color) return false;
    if (!a.text || !b.text || a.lastIdx === null || b.firstIdx === null) return false;
    if (endsSentence(a.text)) return false;
    if (b.page === a.pageTo) return b.firstIdx === a.lastIdx + 1;
    if (b.page === a.pageTo + 1) return flow[a.pageTo].max <= a.lastIdx && flow[b.page].min >= b.firstIdx;
    return false;
  };

  let merged = 0;
  let prev = null;
  for (const ev of events) {
    if (ev.kind === "heading") {
      prev = null;
      continue;
    }
    if (ev.drop) continue;
    if (prev && canMerge(prev, ev)) {
      prev.text = joinLines([prev.text, ev.text], words);
      prev.note = [prev.note, ev.note].filter(Boolean).join("\n\n");
      prev.pageTo = ev.page;
      prev.lastIdx = ev.lastIdx;
      prev.endY = ev.endY;
      prev.endX = ev.endX;
      ev.drop = true;
      merged++;
      continue;
    }
    prev = ev;
  }
  return merged;
}

// ---------------------------------------------------------------------- tree

function buildTree(events, labels, paraAt) {
  const root = { type: "root", children: [] };
  const stack = [];

  const materialise = () => {
    let parent = root;
    for (const s of stack) {
      if (!s.node) {
        s.node = { type: "heading", title: s.ev.title, mark: s.ev.mark || null, page: s.ev.page, children: [] };
        parent.children.push(s.node);
      }
      parent = s.node;
    }
    return parent;
  };

  for (const ev of events) {
    if (ev.kind === "heading") {
      while (stack.length && stack[stack.length - 1].ev.level >= ev.level) stack.pop();
      stack.push({ ev, node: null });
      if (ev.mark) materialise();
      continue;
    }
    if (ev.drop) continue;
    const parent = materialise();
    // Without a printed page number the citation names the paragraph, so a page
    // gets one group per paragraph cited.
    let locator = "";
    if (paraAt && !labels[ev.page]) {
      const heading = stack.length ? stack[stack.length - 1].ev : null;
      const first = heading?.firstPara ?? 1;
      const from = Math.max(1, paraAt(ev.page, ev.x, ev.y) - first + 1);
      const to = Math.max(from, paraAt(ev.pageTo, ev.endX, ev.endY) - first + 1);
      locator = paragraphLocator(heading, stack.length === 1, from, to);
    }
    const key = `${ev.page}-${ev.pageTo}|${locator}`;
    let group = parent.children[parent.children.length - 1];
    if (!group || group.type !== "page" || group.key !== key) {
      group = {
        type: "page",
        key,
        pdfFrom: ev.page + 1,
        pdfTo: ev.pageTo + 1,
        labelFrom: labels[ev.page] || "",
        labelTo: labels[ev.pageTo] || "",
        locator,
        items: [],
      };
      parent.children.push(group);
    }
    group.items.push({ type: ev.type, color: ev.color, text: ev.text, note: ev.note });
  }
  return root.children;
}
