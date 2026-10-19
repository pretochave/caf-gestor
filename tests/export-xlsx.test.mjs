import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createXlsx, downloadXlsx } from "../lib/export-xlsx.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture() {
  return {
    title: "Resultados CaféGestor",
    createdAt: new Date("2026-10-19T15:30:00Z"),
    sheets: [
      {
        name: "Produção / Sul",
        title: "CaféGestor · Safra 2026",
        description: "João & Ana <Sítio> — MG",
        columns: [
          { key: "producer", label: "Produtor", width: 40, format: "text" },
          { key: "amount", label: "Receita (R$)", format: "currency" },
          { key: "bags", label: "Sacas 60 kg", format: "number" },
          { key: "yield", label: "Sacas / ha", format: "decimal" },
          { key: "margin", label: "Margem", format: "percent" },
          { key: "date", label: "Data", format: "date" },
          { key: "active", label: "Ativo" },
        ],
        rows: [
          { producer: "João d'Água & irmãos", amount: 4990.9, bags: 42, yield: 37.125, margin: 0.34125, date: new Date("2026-10-19T00:00:00Z"), active: true },
          { producer: '=HYPERLINK("https://evil.example","abrir")', amount: -12.5, bags: 0, yield: 2.5, margin: 0, date: new Date("2024-02-29T00:00:00Z"), active: false },
          { producer: "  @SUM(A1)\nCafé ☕\u0001", amount: null, bags: undefined, date: null },
        ],
      },
      { name: "Produção / Sul", columns: Array.from({ length: 28 }, (_, i) => ({ key: `c${i}`, label: `Coluna ${i + 1}` })), rows: [{ c26: "AA", c27: 28 }] },
      { name: "Vazio", columns: [{ key: "empty", label: "Sem registros" }], rows: [] },
    ],
  };
}

// Deliberately independent CRC calculation catches damaged local/central entry metadata.
function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function unzipStored(bytes) {
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, "ZIP end directory signature");
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 8) & 0x800, 0x800, "UTF-8 names");
    assert.equal(buffer.readUInt16LE(cursor + 10), 0, "stored ZIP entries");
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const local = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt32LE(local + 14), crc);
    assert.equal(buffer.readUInt32LE(local + 18), size);
    assert.equal(buffer.readUInt32LE(local + 22), size);
    const localNameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    assert.equal(buffer.subarray(local + 30, local + 30 + localNameLength).toString("utf8"), name);
    const content = buffer.subarray(local + 30 + localNameLength + extraLength, local + 30 + localNameLength + extraLength + size);
    assert.equal(checksum(content), crc, `CRC32 for ${name}`);
    entries.set(name, content.toString("utf8"));
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(cursor - centralOffset, buffer.readUInt32LE(end + 12));
  return entries;
}

test("xlsx is a real ZIP with complete OOXML package relationships and valid CRC32", () => {
  const entries = unzipStored(createXlsx(fixture()));
  assert.equal(entries.size, 10);
  for (const path of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "docProps/core.xml", "docProps/app.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]) assert.ok(entries.has(path), path);
  assert.match(entries.get("[Content_Types].xml"), /spreadsheetml\.sheet\.main\+xml/);
  assert.match(entries.get("xl/_rels/workbook.xml.rels"), /Target="worksheets\/sheet3.xml"/);
  assert.match(entries.get("xl/workbook.xml"), /name="Produção   Sul \(2\)"/);
  assert.match(entries.get("docProps/core.xml"), /2026-10-19T15:30:00.000Z/);
});

test("export preserves numeric, boolean and date cells, UTF-8 labels, and safe literal text", () => {
  const entries = unzipStored(createXlsx(fixture()));
  const xml = entries.get("xl/worksheets/sheet1.xml");
  assert.match(xml, /João d&apos;Água &amp; irmãos/);
  assert.match(xml, /João &amp; Ana &lt;Sítio&gt; — MG/);
  assert.match(xml, /<c r="B5" s="4"><v>4990.9<\/v><\/c>/);
  assert.match(xml, /<c r="C6" s="2"><v>0<\/v><\/c>/);
  assert.match(xml, /<c r="G5" s="0" t="b"><v>1<\/v><\/c>/);
  assert.match(xml, /<c r="G6" s="0" t="b"><v>0<\/v><\/c>/);
  const serial = (Date.parse("2026-10-19T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000;
  assert.ok(xml.includes(`<c r="F5" s="6"><v>${serial}</v></c>`));
  assert.match(xml, /<c r="A6" s="0" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(xml, /  @SUM\(A1\)\nCafé ☕/);
  assert.doesNotMatch(xml, /\u0001|<f(?:\s|>)/);
  assert.match(entries.get("xl/styles.xml"), /FF163D2B/);
  assert.match(entries.get("xl/styles.xml"), /&quot;R\$&quot; #,##0.00/);
});

test("report title, frozen headers, filters, column boundaries, and empty datasets are valid", () => {
  const entries = unzipStored(createXlsx(fixture()));
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /<mergeCell ref="A1:G1"/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /<pane ySplit="4" topLeftCell="A5"/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /<autoFilter ref="A4:G7"/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /r="AA2"/);
  assert.match(entries.get("xl/worksheets/sheet2.xml"), /<c r="AB2" s="2"><v>28<\/v>/);
  assert.match(entries.get("xl/worksheets/sheet3.xml"), /<autoFilter ref="A1:A1"/);
  assert.match(entries.get("xl/worksheets/sheet3.xml"), /dimension ref="A1:A1"/);
});

test("invalid data and Excel structural limits fail explicitly instead of corrupting the export", () => {
  assert.throws(() => createXlsx({ sheets: [] }), /ao menos uma/);
  assert.throws(() => createXlsx({ sheets: [{ name: "A", columns: [], rows: [] }] }), /colunas/);
  for (const bad of [NaN, Infinity, -Infinity, new Date("invalid")]) assert.throws(() => createXlsx({ sheets: [{ name: "A", columns: [{ key: "x", label: "Valor" }], rows: [{ x: bad }] }] }), /inválid/);
  assert.throws(() => createXlsx({ sheets: [{ name: "A", columns: [{ key: "x", label: "Valor" }], rows: [{ x: "A".repeat(32768) }] }] }), /32.767/);
  assert.throws(() => createXlsx({ sheets: fixture().sheets, createdAt: new Date("invalid") }), /Data de exportação/);
});

test("browser download uses the Excel MIME, .xlsx extension, and releases its object URL", () => {
  const priorDocument = globalThis.document;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  const priorTimeout = globalThis.setTimeout;
  const anchor = { href: "", download: "", click() { this.clicked = true; }, remove() { this.removed = true; } };
  let blob;
  let revoked;
  try {
    globalThis.document = { createElement: () => anchor, body: { appendChild: element => assert.equal(element, anchor) } };
    URL.createObjectURL = value => { blob = value; return "blob:test-xlsx"; };
    URL.revokeObjectURL = value => { revoked = value; };
    globalThis.setTimeout = callback => { callback(); return 0; };
    downloadXlsx("Relatório: Café.xlsx", fixture());
    assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(anchor.download, "Relatório_ Café.xlsx");
    assert.equal(anchor.href, "blob:test-xlsx");
    assert.equal(anchor.clicked, true);
    assert.equal(anchor.removed, true);
    assert.equal(revoked, "blob:test-xlsx");
  } finally { globalThis.document = priorDocument; URL.createObjectURL = priorCreate; URL.revokeObjectURL = priorRevoke; globalThis.setTimeout = priorTimeout; }
});

test("openpyxl reads the generated workbook without repair or formula execution", { skip: !process.env.CAFEGESTOR_TEST_PYTHON && "Set CAFEGESTOR_TEST_PYTHON to a Python runtime with openpyxl." }, () => {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const temporary = mkdtempSync(join(work, "xlsx-test-"));
  const path = join(temporary, "fixture.xlsx");
  try {
    writeFileSync(path, createXlsx(fixture()));
    const result = spawnSync(process.env.CAFEGESTOR_TEST_PYTHON, [join(root, "tests", "inspect-xlsx.py"), path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    assert.match(result.stdout, /openpyxl: workbook verified/);
  } finally {
    const target = resolve(temporary);
    assert.equal(dirname(target), resolve(work), "Temporary cleanup stays inside the test workspace");
    rmSync(target, { recursive: true, force: true });
  }
});
