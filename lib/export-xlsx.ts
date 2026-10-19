/** A small, dependency-free OOXML exporter shared by the browser reporting screens. */
export type XlsxValue = string | number | boolean | Date | null | undefined;
export type XlsxColumn = {
  key: string;
  label: string;
  width?: number;
  format?: "text" | "number" | "decimal" | "currency" | "percent" | "date";
};
export type XlsxSheet = {
  name: string;
  title?: string;
  description?: string;
  columns: XlsxColumn[];
  rows: Record<string, XlsxValue>[];
};
export type XlsxOptions = { sheets: XlsxSheet[]; title?: string; creator?: string; createdAt?: Date };

const encoder = new TextEncoder();
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const mainNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const maxRows = 1048576;
const maxColumns = 16384;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function columnName(index: number): string {
  let name = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + (current - 1) % 26) + name;
  return name;
}
function inlineCell(reference: string, value: string, style: number): string {
  if (value.length > 32767) throw new RangeError(`A célula ${reference} ultrapassa o limite de 32.767 caracteres do Excel.`);
  // All text is inline text, including a leading =,+,-,@. No user value becomes a formula.
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}
function valueCell(reference: string, value: XlsxValue, column: XlsxColumn): string {
  if (value === null || value === undefined || value === "") return `<c r="${reference}" s="0"/>`;
  if (column.format === "text") return inlineCell(reference, value instanceof Date ? value.toISOString() : String(value), 0);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new RangeError(`Data inválida na célula ${reference}.`);
    const serial = (value.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
    if (serial < 0) return inlineCell(reference, value.toISOString(), 0);
    return `<c r="${reference}" s="6"><v>${serial}</v></c>`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Número inválido na célula ${reference}.`);
    const style = column.format === "currency" ? 4 : column.format === "percent" ? 5 : column.format === "decimal" ? 3 : column.format === "date" ? 6 : column.format === "number" || Number.isInteger(value) ? 2 : 3;
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${reference}" s="0" t="b"><v>${value ? 1 : 0}</v></c>`;
  return inlineCell(reference, value, 0);
}

const styles = `${xmlHeader}<styleSheet xmlns="${mainNs}">
<numFmts count="5"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="#,##0.00"/><numFmt numFmtId="166" formatCode="&quot;R$&quot; #,##0.00;[Red](&quot;R$&quot; #,##0.00)"/><numFmt numFmtId="167" formatCode="0.0%"/><numFmt numFmtId="168" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="4"><font><sz val="11"/><color rgb="FF263B2C"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="18"/><color rgb="FF163D2B"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF75806F"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF163D2B"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFE4E8E0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium4" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

function worksheet(sheet: XlsxSheet): string {
  if (!sheet.columns.length || sheet.columns.length > maxColumns) throw new RangeError("Informe de 1 a 16.384 colunas por planilha.");
  const lastColumn = columnName(sheet.columns.length - 1);
  const rows: string[] = [];
  const merges: string[] = [];
  let row = 1;
  for (const [text, style, height] of [[sheet.title, 7, 34], [sheet.description, 8, 32]] as const) {
    if (!text) continue;
    rows.push(`<row r="${row}" ht="${height}" customHeight="1">${inlineCell(`A${row}`, text, style)}</row>`);
    if (sheet.columns.length > 1) merges.push(`<mergeCell ref="A${row}:${lastColumn}${row}"/>`);
    row++;
  }
  if (sheet.title || sheet.description) row++;
  const headerRow = row;
  if (headerRow + sheet.rows.length > maxRows) throw new RangeError("A planilha ultrapassa o limite de 1.048.576 linhas do Excel.");
  rows.push(`<row r="${row}" ht="30" customHeight="1">${sheet.columns.map((column, i) => inlineCell(`${columnName(i)}${row}`, column.label, 1)).join("")}</row>`);
  for (const record of sheet.rows) {
    row++;
    rows.push(`<row r="${row}" ht="23" customHeight="1">${sheet.columns.map((column, i) => valueCell(`${columnName(i)}${row}`, record[column.key], column)).join("")}</row>`);
  }
  const cols = sheet.columns.map((column, i) => {
    const widths = [column.label.length + 4, ...sheet.rows.slice(0, 100).map(record => Math.min(50, String(record[column.key] ?? "").length + 3))];
    const width = Math.max(9, Math.min(60, Number.isFinite(column.width) ? Number(column.width) : Math.max(13, ...widths)));
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  return `${xmlHeader}<worksheet xmlns="${mainNs}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastColumn}${row}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="23"/><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A${headerRow}:${lastColumn}${row}"/>${merges.length ? `<mergeCells count="${merges.length}">${merges.join("")}</mergeCells>` : ""}<printOptions horizontalCentered="0"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

type ZipEntry = { name: string; content: string };
function zipStored(entries: ZipEntry[], timestamp: Date): Uint8Array {
  if (entries.length > 65535) throw new RangeError("Muitos arquivos para o pacote Excel.");
  const year = Math.max(1980, Math.min(2107, timestamp.getUTCFullYear()));
  const dosDate = (year - 1980) << 9 | (timestamp.getUTCMonth() + 1) << 5 | timestamp.getUTCDate();
  const dosTime = timestamp.getUTCHours() << 11 | timestamp.getUTCMinutes() << 5 | Math.floor(timestamp.getUTCSeconds() / 2);
  const parts = entries.map(entry => { const name = encoder.encode(entry.name); const bytes = encoder.encode(entry.content); return { name, bytes, crc: crc32(bytes), offset: 0 }; });
  const localSize = parts.reduce((sum, part) => sum + 30 + part.name.length + part.bytes.length, 0);
  const centralSize = parts.reduce((sum, part) => sum + 46 + part.name.length, 0);
  if (localSize + centralSize + 22 >= 0xffffffff) throw new RangeError("O arquivo Excel excede o tamanho suportado.");
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of parts) {
    part.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true); view.setUint16(offset + 10, dosTime, true); view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, part.crc, true); view.setUint32(offset + 18, part.bytes.length, true); view.setUint32(offset + 22, part.bytes.length, true);
    view.setUint16(offset + 26, part.name.length, true); view.setUint16(offset + 28, 0, true);
    output.set(part.name, offset + 30); output.set(part.bytes, offset + 30 + part.name.length);
    offset += 30 + part.name.length + part.bytes.length;
  }
  for (const part of parts) {
    view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true); view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, dosTime, true); view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, part.crc, true); view.setUint32(offset + 20, part.bytes.length, true); view.setUint32(offset + 24, part.bytes.length, true);
    view.setUint16(offset + 28, part.name.length, true); view.setUint32(offset + 42, part.offset, true);
    output.set(part.name, offset + 46); offset += 46 + part.name.length;
  }
  view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, parts.length, true); view.setUint16(offset + 10, parts.length, true);
  view.setUint32(offset + 12, centralSize, true); view.setUint32(offset + 16, localSize, true);
  return output;
}

/** Creates a standards-based .xlsx archive; it does not execute or include formulas. */
export function createXlsx(options: XlsxOptions): Uint8Array {
  if (!options.sheets.length) throw new RangeError("Informe ao menos uma planilha para exportar.");
  if (options.sheets.length > 1000) throw new RangeError("Exporte no máximo 1.000 planilhas por arquivo.");
  const timestamp = options.createdAt || new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new RangeError("Data de exportação inválida.");
  const seen = new Set<string>();
  const sheets = options.sheets.map((sheet, index) => {
    const base = sheet.name.replace(/[\[\]:*?/\\\u0000-\u001f]/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31) || `Planilha ${index + 1}`;
    let name = base;
    for (let suffix = 2; seen.has(name.toLowerCase()); suffix++) name = `${base.slice(0, 31 - String(suffix).length - 3)} (${suffix})`;
    seen.add(name.toLowerCase());
    return { ...sheet, name };
  });
  const creator = escapeXml(options.creator || "CaféGestor");
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", content: `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", content: `${xmlHeader}<Relationships xmlns="${packageNs}"><Relationship Id="rId1" Type="${relNs}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${relNs}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", content: `${xmlHeader}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${creator}</dc:creator><dc:title>${escapeXml(options.title || "Relatórios CaféGestor")}</dc:title><cp:lastModifiedBy>${creator}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp.toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp.toISOString()}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", content: `${xmlHeader}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CaféGestor</Application><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map(s => `<vt:lpstr>${escapeXml(s.name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts></Properties>` },
    { name: "xl/workbook.xml", content: `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="${relNs}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `${xmlHeader}<Relationships xmlns="${packageNs}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relNs}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${relNs}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: worksheet(sheet) })),
  ];
  return zipStored(entries, timestamp);
}

/** Downloads a real Excel workbook from a user-initiated browser action. */
export function downloadXlsx(filename: string, options: XlsxOptions): void {
  const bytes = createXlsx(options);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/\.xlsx$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180) + ".xlsx";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
