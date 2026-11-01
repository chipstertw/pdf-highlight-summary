// Renders pages of a PDF to PNG images, for checking the summary's layout.
//   node tools/render-pages.mjs summary.pdf out-folder [first] [last]
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "../vendor/mupdf/mupdf.js";

const [file, outDir, first = "1", last = first] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
fs.mkdirSync(outDir, { recursive: true });
for (let i = Number(first) - 1; i < Math.min(Number(last), doc.countPages()); i++) {
  const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(1.6, 1.6), mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(path.join(outDir, `page-${i + 1}.png`), pix.asPNG());
}
console.log(`${doc.countPages()} pages; outline:`, JSON.stringify((doc.loadOutline() || []).slice(0, 3).map((o) => ({ t: o.title, p: o.page, kids: (o.down || []).length }))));
