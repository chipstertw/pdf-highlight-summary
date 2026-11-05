// Author detection on small hand-built documents. Run with: node --test tools/

import test from "node:test";
import assert from "node:assert/strict";
import { detectReference } from "../src/reference.js";

const line = (text, size = 10) => ({ text, spans: [{ size, text }] });
const doc = (pages, meta = {}) => ({ pages: pages.map((lines) => ({ lines })), meta });
const families = (raw) => detectReference(raw, "file.pdf").authors.map((a) => a.family);

// Ordinary text that uses "may", "key", "concepts", "mark", "stone" and "practice" as plain words.
const bodyText = Array.from({ length: 6 }, () =>
  line("Readers may mark the key concepts in practice and leave no stone unturned while they study."),
);

test("a heading is not mistaken for an author on a page of running text", () => {
  const raw = doc([[line("Learning to Learn", 28), line("Spaced Practice", 16), ...bodyText]], { title: "Sample Study Notes" });
  assert.deepEqual(families(raw), []);
});

test("a heading is not mistaken for an author on a page without running text", () => {
  const raw = doc([[line("Learning to Learn", 28), line("Key Concepts", 16)], bodyText], { title: "Sample Study Notes" });
  assert.deepEqual(families(raw), []);
});

test("the author on a book's title page is found", () => {
  const raw = doc([[line("Gerald Corey", 25), line("Theory and Practice", 30), line("Tenth Edition", 15)], bodyText], { title: "Theory and Practice" });
  assert.deepEqual(families(raw), ["Corey"]);
});

test("a surname that is also an ordinary word survives on a title page", () => {
  const raw = doc([[line("Rollo May", 25), line("Love and Will", 30)], bodyText], { title: "Love and Will" });
  assert.deepEqual(families(raw), ["May"]);
});

test("an author under an article's title is found on a page of running text", () => {
  const raw = doc([[line("Memory in the Classroom", 18), line("Jane Smith", 13), ...bodyText]], { title: "Memory in the Classroom" });
  assert.deepEqual(families(raw), ["Smith"]);
});

const yearAndPublisher = (lines) => {
  const ref = detectReference(doc([[line("Some Title", 30)], lines.map((t) => line(t, 8)), bodyText], { title: "Some Title" }), "file.pdf");
  return [ref.year, ref.publisher];
};

test("year and publisher come from the copyright line", () => {
  assert.deepEqual(yearAndPublisher(["© 2017, 2013, Cengage Learning", "ALL RIGHTS RESERVED."]), ["2017", "Cengage Learning"]);
  assert.deepEqual(yearAndPublisher(["Copyright 2017 Cengage Learning. All Rights Reserved."]), ["2017", "Cengage Learning"]);
});

test("a holder named before the year, and a publisher on its own line, are understood", () => {
  const raw = doc([[line("Gillian Proctor", 20), line("Power in Therapy", 30)], [line("PCCS Books Ltd", 8), line("Monmouth", 8), line("© Gillian Proctor, 2017", 8), line("Copyright, Designs and Patents Act, 1988.", 8)], bodyText], { title: "Power in Therapy", created: "D:20251101" });
  const ref = detectReference(raw, "file.pdf");
  assert.deepEqual([ref.year, ref.publisher], ["2017", "PCCS Books"]);
});

test("a copyright act is not mistaken for the copyright year", () => {
  assert.deepEqual(yearAndPublisher(["Copyright, Designs and Patents Act, 1988."]), ["", ""]);
});

test("the PDF's author field is still used first", () => {
  const raw = doc([[line("Learning to Learn", 28), ...bodyText]], { title: "Learning to Learn", author: "Jane Smith" });
  assert.deepEqual(families(raw), ["Smith"]);
});
