#!/usr/bin/env node
// Command-line version of the web app, for testing and batch use.
//
//   node tools/summarize.mjs book.pdf [output-folder] [--outline] [--json]
//
// --outline prints the summary as an indented outline instead of writing a PDF.
// --json    also writes the analysed summary as JSON next to the PDF.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as mupdf from "../vendor/mupdf/mupdf.js";
import { readPdf } from "../src/read-pdf.js";
import { analyze } from "../src/analyze.js";
import { detectReference, formatApa, fileNameFor } from "../src/reference.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [input, outDir = "."] = args.filter((a) => !a.startsWith("--"));
if (!input) {
  console.error("Usage: node tools/summarize.mjs book.pdf [output-folder] [--outline] [--json]");
  process.exit(1);
}

const t0 = performance.now();
const raw = readPdf(mupdf, fs.readFileSync(input));
const t1 = performance.now();
const summary = analyze(raw);
const t2 = performance.now();
const ref = detectReference(raw, path.basename(input));
const reference = { apa: formatApa(ref), fileName: fileNameFor(ref) };

console.error(`read ${raw.pageCount} pages in ${Math.round(t1 - t0)} ms, analysed in ${Math.round(t2 - t1)} ms`);
console.error(JSON.stringify(summary.stats));
console.error(`APA:  ${reference.apa}`);
console.error(`File: ${reference.fileName}.pdf`);

if (flags.has("--outline")) {
  printOutline(summary.tree, 0);
} else {
  const require = createRequire(import.meta.url);
  const PDFLib = require("../vendor/pdf-lib/pdf-lib.min.js");
  const fontkit = require("../vendor/pdf-lib/fontkit.umd.min.js");
  const { renderSummaryPdf, FONT_FILES } = await import("../src/render-pdf.js");
  const fonts = {};
  for (const [key, file] of Object.entries(FONT_FILES)) fonts[key] = fs.readFileSync(path.join(root, file));
  const bytes = await renderSummaryPdf({ PDFLib, fontkit, fonts, summary, reference, sourceName: path.basename(input) });
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${reference.fileName}.pdf`);
  fs.writeFileSync(out, bytes);
  console.error(`wrote ${out} (${Math.round(bytes.length / 1024)} KB) in ${Math.round(performance.now() - t2)} ms`);
  if (flags.has("--json")) fs.writeFileSync(out.replace(/\.pdf$/, ".json"), JSON.stringify({ reference, ...summary }, null, 2));
}

function printOutline(nodes, depth) {
  const pad = "  ".repeat(depth);
  for (const n of nodes) {
    if (n.type === "heading") {
      const mark = n.mark ? ` [heading highlighted ${n.mark.color}${n.mark.note ? `; note: ${n.mark.note}` : ""}]` : "";
      console.log(`${pad}# ${n.title}${mark}`);
      printOutline(n.children, depth + 1);
    } else {
      const pdf = n.pdfFrom === n.pdfTo ? n.pdfFrom : `${n.pdfFrom}-${n.pdfTo}`;
      const label = n.labelFrom ? (n.labelFrom === n.labelTo ? n.labelFrom : `${n.labelFrom}-${n.labelTo}`) : "";
      console.log(`${pad}[PDF ${pdf}${label ? ` | Actual ${label}` : ""}]`);
      for (const it of n.items) {
        console.log(`${pad}  ${it.color} ${it.type === "Highlight" ? "" : `(${it.type}) `}${it.text}`);
        if (it.note) console.log(`${pad}      NOTE: ${it.note}`);
      }
    }
  }
}
