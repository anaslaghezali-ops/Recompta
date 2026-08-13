import { assignSourceIds, parseSourceFilename, tagSourceFilename } from "./source-id.js";

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: got ${a}, expected ${e}`);
  }
}

assertEqual(
  tagSourceFilename("facture.pdf", "src-2"),
  "facture__RC__src-2.pdf",
  "tag before extension",
);
assertEqual(
  tagSourceFilename("ACHIBEST/FV26.pdf", "src-0"),
  "ACHIBEST/FV26__RC__src-0.pdf",
  "tag keeps folder",
);
assertEqual(parseSourceFilename("facture__RC__src-2.pdf"), {
  filename: "facture.pdf",
  sourceId: "src-2",
}, "parse tagged");
assertEqual(parseSourceFilename("facture.pdf__RC__src-1"), {
  filename: "facture.pdf",
  sourceId: "src-1",
}, "parse legacy");
assertEqual(parseSourceFilename("orange.pdf"), {
  filename: "orange.pdf",
  sourceId: "",
}, "parse untagged");

const records = [
  { id: "src-1", filename: "a.pdf" },
  { id: "src-2", filename: "b.pdf" },
];

assertEqual(
  assignSourceIds(records, [
    { filename: "b.pdf" },
    { filename: "a.pdf" },
  ]),
  ["src-2", "src-1"],
  "match by name when results are reordered",
);

assertEqual(
  assignSourceIds(records, [
    { filename: "b__RC__src-2.pdf" },
    { filename: "a__RC__src-1.pdf" },
  ]),
  ["src-2", "src-1"],
  "match by tag when reordered",
);

assertEqual(
  assignSourceIds(records, [
    { filename: "b.pdf", source_id: "src-2" },
    { filename: "a.pdf", source_id: "src-1" },
  ]),
  ["src-2", "src-1"],
  "match by explicit source_id",
);

assertEqual(
  assignSourceIds(records, [{ filename: "unknown.pdf" }, { filename: "a.pdf" }]),
  ["", "src-1"],
  "no fallback to the first leftover file",
);

console.log("source-id tests ok");
