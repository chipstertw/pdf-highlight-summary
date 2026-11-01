// Text clean-up shared by the reader, the analyser and the reference builder.

const LIGATURES = { "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st" };

// Prefixes that keep their hyphen when a word is split at the end of a line
// and the book itself never shows the word either way mid-line.
const HYPHEN_PREFIXES = new Set(["self", "well", "ill", "all", "ex", "half", "cross", "quasi", "co", "anti", "post", "pre"]);

/** Normalises one run of PDF text: ligatures, odd spaces, soft hyphens, private-use glyphs. */
export function cleanText(s) {
  return s
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c])
    .replace(/\u00AD/g, "")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/ {2,}/g, " ");
}

/** Cleans a note typed by the reader, keeping its paragraph breaks. */
export function cleanNote(s) {
  return (s || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => cleanText(l).trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Letters and digits only, lower-cased: used to compare headings, titles and highlights. */
export const norm = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** "L e a r n i n g  O b j e c t i v e s" -> "Learning Objectives". */
export function collapseLetterSpacing(s) {
  if (!/^(\S ){3,}\S/.test(s)) return s;
  return s.split(/ {2,}/).map((w) => w.replace(/ /g, "")).join(" ");
}

const wordKey = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Every word the document uses mid-line, so line-end hyphens can be resolved against the book itself. */
export function buildWordSet(pages) {
  const words = new Set();
  for (const page of pages) {
    for (const line of page.lines) {
      const tokens = cleanText(line.text).trim().split(" ");
      // The last token may be a word broken by a hyphen, so it does not count.
      const usable = /[-\u2010\u2011]$/.test(tokens[tokens.length - 1] || "") ? tokens.slice(0, -1) : tokens;
      for (const t of usable) {
        const k = wordKey(t);
        if (k.length > 1) words.add(k);
      }
    }
  }
  return words;
}

/**
 * Joins the pieces of text that sit on consecutive lines, repairing words that
 * the typesetter split with a hyphen ("therapeu-" + "tic" -> "therapeutic")
 * while keeping real compounds ("self-" + "awareness" -> "self-awareness").
 */
export function joinLines(parts, words) {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const left = out.match(/(\p{L}+)[-\u2010\u2011]$/u);
    const right = part.match(/^(\p{L}+)/u);
    if (left && right && /^\p{Ll}/u.test(right[1])) {
      const a = left[1].toLowerCase();
      const b = right[1].toLowerCase();
      const joined = words.has(a + b);
      const hyphenated = words.has(`${a}-${b}`);
      const keep = (hyphenated && !joined) || (!joined && HYPHEN_PREFIXES.has(a));
      out = keep ? out.slice(0, -1) + "-" + part : out.slice(0, -1) + part;
    } else if (/[–—/]$/.test(out)) {
      out += part;
    } else {
      out += " " + part;
    }
  }
  return out;
}

/** Strips list bullets and stray symbols that come along when a highlight starts at a bullet. */
export function tidyHighlight(s) {
  return s
    .replace(/^[\s•●○◦▪▫■□►▸‣⁃∙·*]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the text ends a sentence (allowing closing quotes and brackets). */
export const endsSentence = (s) => /[.!?…]["'”’»)\]]*$/.test(s.trim());
