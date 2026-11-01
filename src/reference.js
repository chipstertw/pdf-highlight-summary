// Works out the APA 7 reference and the summary's file name from the PDF itself:
// document info, the title page and the copyright page. Optional online lookup
// (Crossref for a DOI, Open Library for an ISBN) fills gaps when the user asks.
//
// Italics are marked with *asterisks* in the reference text.

import { cleanText, norm } from "./text.js";

const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
const EDITION_SUFFIX = new RegExp(`[,:(\\s]*\\b(?:(\\d{1,2})(?:st|nd|rd|th)|(${ORDINAL_WORDS.join("|")}))\\s+ed(?:ition|\\.)?\\)?\\.?\\s*$`, "i");
const NOT_A_NAME = /university|college|institute|press|publish|learning|edition|education|library|department|school|inc\b|ltd\b|llc\b|copyright|www|http|@|\d/i;
const PARTICLES = new Set(["van", "von", "de", "der", "den", "da", "di", "du", "le", "la", "del", "dos", "das", "ter", "ten", "bin", "al"]);
const DEGREES = /,?\s*\b(ph\.?\s?d|ed\.?\s?d|psy\.?\s?d|m\.?\s?d|m\.?\s?a|m\.?\s?s|lpcc?|lmft|lcsw|abpp|ncc)\.?(?=\s|,|$)/gi;
const COPYRIGHT = /(?:©|\(c\)|copyright)\s*(?:©\s*)?(?:by\s+)?((?:19|20)\d{2})/i;

export function detectReference(raw, fileName) {
  const front = raw.pages.slice(0, Math.min(raw.pages.length, 20));
  const bodySize = typicalSize(raw.pages);

  // Title and edition: the PDF's own title field, else the biggest text near the front.
  let title = cleanMetaTitle(raw.meta.title);
  let edition = null;
  if (title) {
    const m = title.match(EDITION_SUFFIX);
    if (m) {
      edition = m[1] ? Number(m[1]) : ORDINAL_WORDS.indexOf(m[2].toLowerCase()) + 1;
      title = title.slice(0, m.index).trim();
    }
  }
  const titlePage = findTitlePage(front, title, bodySize);
  if (!title && titlePage) title = titlePage.title;
  const fileTitle = fileName.replace(/\.pdf$/i, "").trim();
  if (!title) title = fileTitle;

  if (!edition && titlePage) {
    for (const t of titlePage.lines) {
      const m = t.match(/^(?:(\d{1,2})(?:st|nd|rd|th)|(\w+))\s+edition$/i);
      if (m && (m[1] || ORDINAL_WORDS.includes(m[2].toLowerCase()))) {
        edition = m[1] ? Number(m[1]) : ORDINAL_WORDS.indexOf(m[2].toLowerCase()) + 1;
        break;
      }
    }
  }

  // Authors: the PDF's author field when it holds real names, else names on the title page.
  let authors = parseAuthorList(raw.meta.author);
  if (!authors.length && titlePage) {
    const ordinaryWords = lowerCaseWords(raw.pages);
    for (const t of titlePage.candidates) {
      if (titleContains(title, t)) continue;
      const names = parseAuthorList(t);
      if (names.length && readsLikeNames(names, ordinaryWords, titlePage.hasRunningText)) {
        authors = names;
        break;
      }
    }
  }

  // Year and publisher: the first copyright line near the front of the book.
  let year = "";
  let publisher = "";
  for (const page of front) {
    for (const line of page.lines) {
      const t = cleanText(line.text).trim();
      const m = t.match(COPYRIGHT);
      if (!m) continue;
      year = m[1];
      publisher = publisherFrom(t.slice(m.index), authors);
      break;
    }
    if (year) break;
  }
  if (!year) {
    const m = (raw.meta.created || "").match(/(?:D:)?((?:19|20)\d{2})/);
    if (m) year = m[1];
  }

  const frontText = front.map((p) => p.lines.map((l) => cleanText(l.text)).join("\n")).join("\n");
  const isbnMatch = frontText.match(/ISBN(?:-1[03])?[:\s]*((?:97[89][-\s]?)?\d[\d\s-]{7,15}[\dX])\b/i);
  const isbn = isbnMatch ? isbnMatch[1].replace(/[^\dX]/gi, "") : "";
  const doiText = raw.pages.slice(0, 3).map((p) => p.lines.map((l) => l.text).join(" ")).join(" ") + " " + (raw.meta.subject || "");
  const doiMatch = doiText.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/);
  const doi = doiMatch ? doiMatch[1].replace(/[.,;)\]]+$/, "") : "";

  const ref = {
    kind: doi && !isbn && raw.pages.length < 120 ? "article" : "book",
    authors,
    year,
    yearFromCopyright: !!year,
    title,
    edition,
    publisher,
    journal: "",
    volume: "",
    issue: "",
    pages: "",
    isbn: isbn.length === 10 || isbn.length === 13 ? isbn : "",
    doi,
    fileTitle,
  };
  ref.properNouns = properNounsIn(raw.pages, title);
  return ref;
}

function typicalSize(pages) {
  const counts = new Map();
  for (const p of pages.slice(0, 60)) {
    for (const l of p.lines) {
      const s = Math.round((l.spans[0]?.size || 10) * 2) / 2;
      counts.set(s, (counts.get(s) || 0) + l.text.length);
    }
  }
  let best = 10;
  let n = -1;
  for (const [s, c] of counts) {
    if (c > n) {
      best = s;
      n = c;
    }
  }
  return best;
}

function cleanMetaTitle(t) {
  let s = cleanText(t || "").trim();
  s = s.replace(/^microsoft (word|powerpoint) - /i, "").replace(/\.(pdf|docx?|indd|tex|pptx?|qxd|rtf)$/i, "").trim();
  if (letters(s) < 3 || /^untitled\b/i.test(s) || /^[\w-]+\.\w{2,4}$/.test(s)) return "";
  return s;
}

const letters = (s) => (s.match(/\p{L}/gu) || []).length;

function titleContains(title, line) {
  const a = norm(title);
  const b = norm(line);
  return !!b && a.includes(b);
}

/** The title page: big type that matches the known title (or the biggest type near the front). */
function findTitlePage(front, knownTitle, bodySize) {
  let best = null;
  for (const page of front) {
    const big = page.lines.filter((l) => (l.spans[0]?.size || 0) >= bodySize * 1.25 && letters(l.text) >= 2);
    if (!big.length) continue;
    const texts = big.map((l) => cleanText(l.text).trim());
    const maxSize = Math.max(...big.map((l) => l.spans[0].size));
    const titleLines = big.filter((l) => Math.abs(l.spans[0].size - maxSize) < 0.5).map((l) => cleanText(l.text).trim());
    const pageTitle = titleLines.join(" ").replace(/\s+/g, " ").trim();
    const matchesKnown = knownTitle && norm(texts.join(" ")).includes(norm(knownTitle).slice(0, 24));
    const score = (matchesKnown ? 1000 : 0) + maxSize;
    if (!best || score > best.score) {
      const lines = page.lines.map((l) => cleanText(l.text).trim()).filter(Boolean);
      const candidates = page.lines
        .filter((l) => (l.spans[0]?.size || 0) >= bodySize * 1.15)
        .map((l) => cleanText(l.text).trim())
        .filter((t) => t && !NOT_A_NAME.test(t));
      const hasRunningText = lines.filter((t) => t.split(" ").length >= 8).length > 2;
      best = { score, title: pageTitle, lines, candidates, hasRunningText };
    }
  }
  return best;
}

/** Every word the document uses in lower case, meaning as an ordinary word rather than a name. */
function lowerCaseWords(pages) {
  const words = new Set();
  for (const page of pages) {
    for (const line of page.lines) {
      for (const token of cleanText(line.text).split(/\s+/)) {
        const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
        if (/^\p{Ll}/u.test(word)) words.add(word);
      }
    }
  }
  return words;
}

/**
 * A heading such as "Key Concepts" can look just like a name, but people's names
 * rarely appear in the text as ordinary lower-case words. On a page of running
 * text, one such word rules a line out. On a true title page a surname may be an
 * ordinary word ("Rollo May"), so only a line made entirely of them is ruled out.
 */
function readsLikeNames(names, ordinaryWords, strict) {
  const words = names
    .flatMap((n) => `${n.given} ${n.family}`.split(/\s+/))
    .map((w) => w.replace(/[^\p{L}]/gu, "").toLowerCase())
    .filter((w) => w.length > 1 && !PARTICLES.has(w));
  const ordinary = words.filter((w) => ordinaryWords.has(w)).length;
  return strict ? ordinary === 0 : ordinary < words.length;
}

function parseName(s) {
  let t = s.replace(DEGREES, "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim().replace(/[,;]$/, "");
  if (!t) return null;
  if (t.includes(",")) {
    const [family, given] = t.split(",").map((x) => x.trim());
    return family && given ? { family, given } : null;
  }
  const parts = t.split(" ");
  if (parts.length < 2 || parts.length > 5) return null;
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return { family: parts.slice(i).join(" "), given: parts.slice(0, i).join(" ") };
}

function looksLikeName(s) {
  if (NOT_A_NAME.test(s)) return false;
  return /^\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|van|von|de|der|den|da|di|du|le|la|del))+$/u.test(s.trim());
}

/** "Gerald Corey", "Corey, Gerald", "A. Smith and B. Jones", "Smith, A.; Jones, B." */
export function parseAuthorList(text) {
  const s = cleanText(text || "").replace(DEGREES, "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  let pieces;
  if (s.includes(";")) pieces = s.split(/\s*;\s*/);
  else if (/^[^,]+,\s*[\p{Lu}][\p{L}.]*\.?(\s+[\p{Lu}]\.)*$/u.test(s)) pieces = [s];
  else pieces = s.split(/\s*(?:,\s*and\s+|,\s*&\s*|\s+and\s+|\s*&\s*|,\s*)\s*/);
  const names = [];
  for (const p of pieces) {
    const piece = p.trim();
    if (!piece) continue;
    const plain = piece.includes(",") ? piece.split(",").reverse().join(" ").trim() : piece;
    if (!looksLikeName(plain)) return [];
    const n = parseName(piece);
    if (!n) return [];
    names.push(n);
  }
  return names;
}

function publisherFrom(line, authors) {
  let rest = line
    .replace(COPYRIGHT, "")
    .replace(/^[\s,]*(?:(?:19|20)\d{2}[\s,]*)*/, "")
    .replace(/^by\s+/i, "")
    .split(/\.\s|\s{2,}|all rights reserved/i)[0]
    .replace(/[.,;:\s]+$/, "")
    .replace(/,?\s+(inc|ltd|llc|co|corp|corporation|limited|gmbh|plc)\.?$/i, "")
    .trim();
  if (!rest || rest.length > 60 || letters(rest) < 3) return "";
  if (authors.some((a) => norm(rest).includes(norm(a.family)))) return "";
  return rest;
}

/** Words that the book only ever capitalises (proper nouns), so sentence case keeps them. */
function properNounsIn(pages, title) {
  const want = new Map();
  for (const w of title.split(/\s+/)) {
    const k = w.replace(/[^\p{L}'’-]/gu, "");
    if (k && /^\p{Lu}/u.test(k)) want.set(k.toLowerCase(), { upper: 0, lower: 0 });
  }
  if (!want.size) return [];
  for (const page of pages) {
    for (const line of page.lines) {
      const tokens = line.text.split(/\s+/);
      for (let i = 1; i < tokens.length; i++) {
        const k = tokens[i].replace(/[^\p{L}'’-]/gu, "");
        const entry = want.get(k.toLowerCase());
        if (!entry || /[.!?:]$/.test(tokens[i - 1])) continue;
        if (/^\p{Lu}/u.test(k)) entry.upper++;
        else entry.lower++;
      }
    }
  }
  return [...want].filter(([, c]) => c.upper >= 3 && c.lower === 0).map(([k]) => k);
}

// ---------------------------------------------------------------- formatting

export function sentenceCase(title, properNouns = []) {
  const keep = new Set(properNouns);
  let capNext = true;
  return title
    .split(/(\s+)/)
    .map((tok) => {
      if (!tok.trim()) return tok;
      const word = tok.replace(/[^\p{L}]/gu, "");
      const acronym = word.length >= 2 && word === word.toUpperCase() && /\p{Lu}/u.test(word);
      const mixed = /\p{Ll}\p{Lu}/u.test(tok);
      const proper = keep.has(tok.replace(/[^\p{L}'’-]/gu, "").toLowerCase()) || tok === "I";
      let out = tok;
      if (capNext) out = tok.replace(/\p{L}/u, (c) => c.toUpperCase());
      else if (!acronym && !mixed && !proper) out = tok.toLowerCase();
      capNext = /[:?!.—]$/.test(tok);
      return out;
    })
    .join("");
}

function initials(given) {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .map((p) => p.replace(/[^\p{L}]/gu, "").charAt(0).toUpperCase() + ".")
        .join("-"),
    )
    .join(" ");
}

export function formatAuthors(authors) {
  const names = authors.map((a) => (a.given ? `${a.family}, ${initials(a.given)}` : a.family));
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(", ")}, . . . ${names[names.length - 1]}`;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const endWithPeriod = (s) => (/[.?!]$/.test(s) ? s : s + ".");

/** APA 7 reference; *asterisks* mark italics. */
export function formatApa(ref) {
  const authors = formatAuthors(ref.authors);
  const year = `(${ref.year || "n.d."})`;
  const title = sentenceCase(ref.title, ref.properNouns);
  if (ref.kind === "article") {
    let source = ref.journal ? `*${ref.journal}*` : "";
    if (ref.volume) source += `, *${ref.volume}*` + (ref.issue ? `(${ref.issue})` : "");
    if (ref.pages) source += `, ${ref.pages}`;
    const parts = [authors ? `${authors} ${year}.` : "", authors ? endWithPeriod(title) : `${endWithPeriod(title)} ${year}.`, source ? source + "." : "", ref.doi ? `https://doi.org/${ref.doi}` : ""];
    return parts.filter(Boolean).join(" ");
  }
  const ed = ref.edition && ref.edition > 1 ? ` (${ordinal(ref.edition)} ed.)` : "";
  const work = `*${title}*${ed}`;
  const publisher = ref.publisher ? endWithPeriod(ref.publisher) : "";
  const parts = authors ? [`${authors} ${year}.`, endWithPeriod(work), publisher] : [endWithPeriod(work), `${year}.`, publisher];
  return parts.filter(Boolean).join(" ");
}

/** "Corey (2017) Theory and Practice of Counseling and Psychotherapy" */
export function fileNameFor(ref) {
  const families = ref.authors.map((a) => a.family);
  const who = families.length === 0 ? "" : families.length === 1 ? families[0] : families.length === 2 ? `${families[0]} & ${families[1]}` : `${families[0]} et al.`;
  const name = [who, `(${ref.year || "n.d."})`, ref.title].filter(Boolean).join(" ");
  return name.replace(/:\s*/g, " - ").replace(/[\\/*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
}

// ------------------------------------------------------------- online lookup

/** "Corey, G." + "Cory, G." + "Corey, G. F." are one person typed three ways. */
function dedupeAuthors(authors) {
  const out = [];
  const close = (a, b) => {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
  };
  for (const a of authors) {
    const fam = norm(a.family);
    const init = norm(a.given).charAt(0);
    if (!out.some((o) => norm(o.given).charAt(0) === init && close(norm(o.family), fam))) out.push(a);
  }
  return out;
}

/** Fills in the reference from Crossref (DOI) or Open Library (ISBN). Sends only the identifier. */
export async function lookupReference(ref, fetchImpl = fetch) {
  if (ref.doi) {
    const res = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(ref.doi)}`);
    if (!res.ok) throw new Error(`Crossref could not find DOI ${ref.doi}.`);
    const w = (await res.json()).message;
    const date = (w.issued || w["published-print"] || w["published-online"] || {})["date-parts"]?.[0];
    const kind = /book/.test(w.type) && !/chapter/.test(w.type) ? "book" : "article";
    return {
      ...ref,
      kind,
      authors: (w.author || []).map((a) => ({ family: a.family || a.name || "", given: a.given || "" })).filter((a) => a.family),
      year: date?.[0] ? String(date[0]) : ref.year,
      title: [w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(": ") || ref.title,
      journal: w["container-title"]?.[0] || "",
      volume: w.volume || "",
      issue: w.issue || "",
      pages: (w.page || "").replace(/-/g, "–"),
      publisher: kind === "book" ? w.publisher || ref.publisher : ref.publisher,
      edition: w["edition-number"] ? Number(w["edition-number"]) : ref.edition,
      properNouns: [],
    };
  }
  if (ref.isbn) {
    const key = `ISBN:${ref.isbn}`;
    const res = await fetchImpl(`https://openlibrary.org/api/books?bibkeys=${key}&format=json&jscmd=data`);
    if (!res.ok) throw new Error("Open Library did not respond.");
    const b = (await res.json())[key];
    if (!b) throw new Error(`Open Library has no record for ISBN ${ref.isbn}.`);
    // Open Library records are crowd-edited, so they only fill what the PDF itself lacks.
    const authors = dedupeAuthors((b.authors || []).map((a) => parseName(a.name)).filter(Boolean));
    const published = (b.publish_date || "").match(/(?:19|20)\d{2}/);
    const titleFromFile = !ref.title || norm(ref.title) === norm(ref.fileTitle || "");
    return {
      ...ref,
      kind: "book",
      authors: ref.authors.length ? ref.authors : authors,
      year: ref.year || (published ? published[0] : ""),
      title: titleFromFile ? [b.title, b.subtitle].filter(Boolean).join(": ") || ref.title : ref.title,
      publisher: ref.publisher || (b.publishers?.[0]?.name || "").replace(/,?\s+(inc|ltd|llc)\.?$/i, ""),
    };
  }
  throw new Error("No DOI or ISBN was found in this PDF.");
}
