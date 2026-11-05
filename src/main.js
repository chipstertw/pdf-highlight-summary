// Page logic: pick a PDF, analyse it in a worker, show a preview, build the summary PDF.

import { formatApa, fileNameFor, lookupReference } from "./reference.js";
import { renderSummaryPdf, FONT_FILES, pageLabel, parseItalics } from "./render-pdf.js";

const $ = (id) => document.getElementById(id);
const stages = { pick: $("pick"), working: $("working"), error: $("error"), result: $("result") };
const emptyPreview = $("preview").innerHTML; // the placeholder shown before a PDF is chosen

let worker = null;
let jobId = 0;
let current = null; // { summary, ref, sourceName }
let downloadUrl = null;
let buildTimer = null;
let building = null;
let fontBytes = null;

showSourceLink();

// ------------------------------------------------------------------ picking

$("file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) start(file);
});

const dropzone = $("dropzone");
for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    if (!stages.pick.hidden) dropzone.classList.add("is-over");
  });
}
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropzone.classList.remove("is-over");
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dropzone.classList.remove("is-over");
  if (stages.working.hidden === false) return;
  const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (file) start(file);
  else showError("That doesn't look like a PDF. Choose a .pdf file.");
});

$("again").addEventListener("click", reset);
$("error-again").addEventListener("click", reset);

function show(name) {
  for (const [key, el] of Object.entries(stages)) el.hidden = key !== name;
}

function reset() {
  current = null;
  show("pick");
  $("preview").innerHTML = emptyPreview;
  $("file").focus();
}

function showError(message) {
  $("error-text").textContent = message;
  show("error");
}

// ---------------------------------------------------------------- analysing

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onWorkerMessage;
    worker.onerror = () => {
      worker = null;
      showError("This browser couldn't start the PDF reader. Please use a recent version of Safari, Chrome, Edge or Firefox.");
    };
  }
  return worker;
}

async function start(file) {
  const id = ++jobId;
  $("working-file").textContent = file.name;
  setProgress("Opening the PDF…", null);
  show("working");
  try {
    const bytes = await file.arrayBuffer();
    if (id !== jobId) return;
    current = { sourceName: file.name };
    getWorker().postMessage({ id, bytes, name: file.name }, [bytes]);
  } catch {
    showError("This file couldn't be read. Is it still on your computer?");
  }
}

function setProgress(text, fraction) {
  $("status").textContent = text;
  const meter = $("meter").parentElement;
  meter.classList.toggle("is-indeterminate", fraction === null);
  if (fraction !== null) {
    $("meter").style.width = `${Math.round(fraction * 100)}%`;
    meter.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
  } else {
    $("meter").style.width = "";
    meter.removeAttribute("aria-valuenow");
  }
}

function onWorkerMessage({ data }) {
  if (data.id !== jobId) return;
  if (data.type === "progress") {
    if (data.stage === "engine") setProgress("Loading the PDF reader…", null);
    else if (data.stage === "pages") setProgress(`Reading page ${data.done} of ${data.total}…`, data.done / data.total);
    else setProgress("Organising highlights by heading…", null);
  } else if (data.type === "error") {
    showError(data.message);
  } else if (data.type === "done") {
    current = { ...current, summary: data.summary, ref: data.ref };
    showResult();
  }
}

// ------------------------------------------------------------------ result

function showResult() {
  const { summary, ref } = current;
  const s = summary.stats;
  $("stats").textContent = `${plural(s.entries, "highlight")} and ${plural(s.notes, "note")} from ${plural(s.pages, "page")}.`;

  const warnings = [];
  if (!s.entries) warnings.push("No highlights or notes were found. If you marked this PDF in another app, check that the app saves highlights into the PDF file itself.");
  if (s.emptyHighlights) warnings.push(`${plural(s.emptyHighlights, "highlight")} had no readable text underneath. Scanned pages need text recognition (OCR) first.`);
  $("warning").textContent = warnings.join(" ");
  $("warning").hidden = !warnings.length;

  $("apa").value = formatApa(ref);
  $("filename").value = fileNameFor(ref);
  setupLookup(ref);

  show("result");
  renderPreview();
  scheduleBuild(0);
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

$("apa").addEventListener("input", () => {
  renderPreview();
  scheduleBuild();
});
$("filename").addEventListener("input", () => {
  renderPreview();
  scheduleBuild();
});

function setupLookup(ref) {
  const box = $("lookup-box");
  const button = $("lookup");
  box.hidden = !(ref.doi || ref.isbn);
  if (box.hidden) return;
  const id = ref.doi ? `DOI ${ref.doi}` : `ISBN ${ref.isbn}`;
  const service = ref.doi ? "Crossref" : "Open Library";
  button.textContent = `Fill in from ${id}`;
  button.disabled = false;
  $("lookup-hint").textContent = `Asks ${service} for the details. Only the ${ref.doi ? "DOI" : "ISBN"} is sent.`;
}

$("lookup").addEventListener("click", async () => {
  const button = $("lookup");
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Looking up…";
  try {
    const ref = await lookupReference(current.ref);
    const apa = formatApa(ref);
    if (apa === formatApa(current.ref)) {
      $("lookup-hint").textContent = "Nothing to add: the PDF already had these details.";
      return;
    }
    current.ref = ref;
    $("apa").value = apa;
    $("filename").value = fileNameFor(ref);
    $("lookup-hint").textContent = "Filled in from the online record. Check it before you use it.";
    renderPreview();
    scheduleBuild(0);
  } catch (err) {
    $("lookup-hint").textContent = err?.message || "The lookup didn't work. You can edit the reference by hand.";
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
});

// --------------------------------------------------------------- the PDF

function scheduleBuild(delay = 400) {
  const link = $("download");
  link.setAttribute("aria-disabled", "true");
  link.textContent = "Preparing PDF…";
  clearTimeout(buildTimer);
  buildTimer = setTimeout(buildPdf, delay);
}

async function buildPdf() {
  if (!current?.summary) return;
  const snapshot = { apa: $("apa").value.trim(), fileName: cleanFileName($("filename").value) };
  const run = (building = (async () => {
    if (!window.PDFLib || !window.fontkit) throw new Error("The PDF writer didn't load. Reload the page and try again.");
    fontBytes ??= Object.fromEntries(
      await Promise.all(
        Object.entries(FONT_FILES).map(async ([key, path]) => {
          const res = await fetch(path);
          if (!res.ok) throw new Error(`Couldn't load ${path}.`);
          return [key, new Uint8Array(await res.arrayBuffer())];
        }),
      ),
    );
    return renderSummaryPdf({
      PDFLib: window.PDFLib,
      fontkit: window.fontkit,
      fonts: fontBytes,
      summary: current.summary,
      reference: snapshot,
      sourceName: current.sourceName,
    });
  })());
  try {
    const bytes = await run;
    if (building !== run) return; // a newer build started
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = $("download");
    link.href = downloadUrl;
    link.download = `${snapshot.fileName || "Highlights"}.pdf`;
    link.textContent = "Download summary PDF";
    link.setAttribute("aria-disabled", current.summary.stats.entries ? "false" : "true");
  } catch (err) {
    if (building !== run) return;
    console.error(err);
    $("download").textContent = "Couldn't build the PDF";
    $("warning").textContent = err?.message || String(err);
    $("warning").hidden = false;
  }
}

function cleanFileName(name) {
  return name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
}

// ----------------------------------------------------------- preview

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : "#999999");

function noteEl(text) {
  const p = el("p", "note");
  p.append(el("b", "", "Note: "), document.createTextNode(text));
  return p;
}

function renderPreview() {
  const sheet = $("preview");
  const { summary } = current;
  const frag = document.createDocumentFragment();

  frag.append(el("p", "kicker", "Highlights & notes"));
  const ref = el("p", "reference");
  for (const run of parseItalics($("apa").value.trim())) ref.append(run.italic ? el("i", "", run.text) : document.createTextNode(run.text));
  frag.append(ref);
  const facts = [plural(summary.stats.entries, "highlight"), plural(summary.stats.notes, "note")];
  if (summary.stats.paragraphLocators) facts.push("no page numbers, so cited by paragraph (APA 7)");
  facts.push(`from “${current.sourceName}”`);
  frag.append(el("p", "facts", facts.join(" · ")));

  if (!summary.tree.length) frag.append(el("p", "empty", "No highlights or notes were found in this PDF."));

  const walk = (nodes, depth, parent) => {
    for (const n of nodes) {
      if (n.type === "heading") {
        const section = el("section", "node");
        const level = Math.min(depth + 2, 6);
        const h = el(`h${level}`, `heading d${Math.min(depth, 3)}`, n.title);
        if (n.mark) {
          h.classList.add("marked");
          h.style.setProperty("--mark", safeColor(n.mark.color));
        }
        section.append(h);
        if (n.mark?.note) section.append(noteEl(n.mark.note));
        walk(n.children, depth + 1, section);
        parent.append(section);
      } else {
        const group = el("div", "page-group");
        group.append(el("p", "page-label", pageLabel(n, $("filename").value)));
        for (const item of n.items) {
          const div = el("div", "item");
          div.style.setProperty("--mark", safeColor(item.color));
          if (item.text) div.append(el("blockquote", item.type === "StrikeOut" ? "strike" : "", item.text));
          if (item.note) div.append(noteEl(item.note));
          group.append(div);
        }
        parent.append(group);
      }
    }
  };
  walk(summary.tree, 0, frag);
  sheet.replaceChildren(frag);
}

// On GitHub Pages (user.github.io/repo) the footer links to the repository.
function showSourceLink() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return;
  const repo = location.pathname.split("/").filter(Boolean)[0];
  $("source-link").href = `https://github.com/${m[1]}/${repo || `${m[1]}.github.io`}`;
  $("source-link-wrap").hidden = false;
}
