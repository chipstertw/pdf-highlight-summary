// Reads and analyses the PDF off the main thread so the page stays responsive.

import { readPdf, UserFacingError } from "./read-pdf.js";
import { analyze } from "./analyze.js";
import { detectReference } from "./reference.js";

let engine = null;
const loadEngine = () => (engine ??= import("../vendor/mupdf/mupdf.js"));

self.onmessage = async ({ data }) => {
  const { id, bytes, name } = data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    post({ type: "progress", stage: "engine" });
    const mupdf = await loadEngine();
    const raw = readPdf(mupdf, new Uint8Array(bytes), (done, total) => post({ type: "progress", stage: "pages", done, total }));
    post({ type: "progress", stage: "analyse" });
    const summary = analyze(raw);
    const ref = detectReference(raw, name);
    post({ type: "done", summary, ref });
  } catch (err) {
    console.error(err);
    const message = err instanceof UserFacingError ? err.message : `Something went wrong while reading this PDF (${err?.message || err}).`;
    post({ type: "error", message });
  }
};
