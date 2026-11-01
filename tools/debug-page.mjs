// Prints the lines, styles and highlights of one page, for tuning the analyser.
//   node tools/debug-page.mjs book.pdf <page number as shown in the PDF viewer>
import fs from "node:fs";
import * as mupdf from "../vendor/mupdf/mupdf.js";
import { readPdf } from "../src/read-pdf.js";

const [file, pageArg] = process.argv.slice(2);
const want = Number(pageArg) - 1;
const raw = readPdf(mupdf, fs.readFileSync(file));
const page = raw.pages[want];
for (const l of page.lines) {
  const s = l.spans.find((x) => x.text.trim()) || l.spans[0];
  console.log(`L${l.n} b${l.block} y${l.y0.toFixed(1)}-${l.y1.toFixed(1)} x${l.x0.toFixed(0)}-${l.x1.toFixed(0)} c${l.c0}-${l.c1} ${s.size} ${s.bold ? "B" : " "} ${s.font.slice(0, 22).padEnd(22)} ${s.color} | ${l.text.slice(0, 90)}`);
}
for (const m of page.marks) {
  console.log(`MARK ${m.type} ${m.color} note=${JSON.stringify(m.note)}`);
  for (const f of m.frags) console.log(`    L${f.n} idx ${f.i0}-${f.i1}: ${JSON.stringify(f.text)}`);
}
