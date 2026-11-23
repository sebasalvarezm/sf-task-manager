import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { ExportError, buildWorkbook, exportFilename, parseExportRequest, safeUrl, sheetName } from "@/lib/xlsx-export";

const sample = {
  filename: "Potential outreach · Ilan Bernadski - 2026-11-01 to 2026-11-23",
  sheets: [
    {
      name: "Potential outreach",
      title: "Potential outreach · Ilan Bernadski",
      subtitle: "Outside 7 core countries · founded after 2019 · under 15 staff",
      columns: [
        { key: "company", header: "Company" },
        { key: "website", header: "Website" },
        { key: "sent", header: "Sent", type: "date" },
        { key: "country", header: "Country" },
        { key: "founded", header: "Founded", type: "integer" },
        { key: "employees", header: "Employees", type: "integer" },
        { key: "amount", header: "Amount", type: "money" },
        { key: "share", header: "Share", type: "percent" },
      ],
      rows: [
        { company: { value: "Systecon Group AB", url: "https://valstone.my.salesforce.com/001A" }, website: { value: "systecongroup.com", url: "https://systecongroup.com" }, sent: "2026-11-18", country: { value: "Sweden", tone: "bad" }, founded: "1970", employees: 63, amount: 1500000, share: 0.073 },
        { company: "Engage Automation", website: null, sent: "2026-11-18T14:00:00Z", country: { value: "Not set", tone: "warn" }, founded: 2003, employees: { value: 7, tone: "warn" }, amount: null, share: "12.5%" },
        { company: { value: "Evil", url: "javascript:alert(1)" }, sent: "not a date", founded: "n/a", employees: "1,234", extra: "ignored" },
      ],
    },
  ],
};

async function reread(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("parseExportRequest", () => {
  it("keeps only declared columns, drops unsafe links and unknown tones", () => {
    const req = parseExportRequest(sample);
    expect(req.filename).toBe("Potential outreach Ilan Bernadski - 2026-11-01 to 2026-11-23.xlsx");
    const rows = req.sheets[0].rows;
    expect(Object.keys(rows[2])).not.toContain("extra");
    expect(rows[2].company).toEqual({ value: "Evil", url: null, tone: null });
    expect(parseExportRequest({ sheets: [{ name: "x", columns: [{ key: "a", header: "A" }], rows: [{ a: { value: 1, tone: "pink" } }] }] }).sheets[0].rows[0].a).toEqual({ value: 1, url: null, tone: null });
  });
  it("refuses empty, oversized and malformed requests with a plain message", () => {
    expect(() => parseExportRequest(null)).toThrow(ExportError);
    expect(() => parseExportRequest({ sheets: [] })).toThrow(/Nothing to export/);
    expect(() => parseExportRequest({ sheets: [{ name: "x", columns: [] }] })).toThrow(/no columns/);
    expect(() => parseExportRequest({ sheets: [{ name: "x", columns: [{ key: "a", header: "A" }, { key: "a", header: "B" }] }] })).toThrow(/distinct/);
    const many = Array.from({ length: 20_001 }, () => ({ a: 1 }));
    expect(() => parseExportRequest({ sheets: [{ name: "x", columns: [{ key: "a", header: "A" }], rows: many }] })).toThrow(/Too many rows/);
    expect(() => parseExportRequest({ sheets: Array.from({ length: 11 }, () => ({ name: "x", columns: [{ key: "a", header: "A" }] })) })).toThrow(/Too many sheets/);
  });
  it("helpers: safe links, sheet names, file names", () => {
    expect(safeUrl("https://a.com")).toBe("https://a.com");
    expect(safeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///c:/x")).toBeNull();
    const taken = new Set<string>();
    expect(sheetName("BRO: Pre-DD / IOI [open]?", taken)).toBe("BRO Pre-DD IOI open");
    expect(sheetName("BRO: Pre-DD / IOI [open]?", taken)).toBe("BRO Pre-DD IOI open 2");
    expect(sheetName("A very long sheet name that goes past thirty-one characters", taken).length).toBeLessThanOrEqual(31);
    expect(exportFilename("")).toBe("Export.xlsx");
    expect(exportFilename('a/b\\c:"d".xlsx')).toBe("a b c d.xlsx");
  });
});

describe("buildWorkbook", () => {
  it("writes a styled sheet: title block, navy header, frozen, filtered, real numbers, dates and links", async () => {
    const buf = await buildWorkbook(parseExportRequest(sample), new Date("2026-11-23T15:00:00Z"));
    const wb = await reread(buf);
    const ws = wb.getWorksheet("Potential outreach")!;
    expect(ws).toBeDefined();
    expect(ws.getCell("A1").value).toBe("Potential outreach · Ilan Bernadski");
    expect(ws.getCell("A1").font?.bold).toBe(true);
    expect(String(ws.getCell("A3").value)).toMatch(/^3 rows · exported Nov 23, 2026, 10:00 AM ET$/);
    // Header on row 5 (title, subtitle, exported line, blank).
    expect(ws.getCell("A5").value).toBe("Company");
    expect((ws.getCell("A5").fill as ExcelJS.FillPattern).fgColor?.argb).toMatch(/1B2A4A$/);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 5 });
    expect(ws.autoFilter).toBeTruthy();
    // Row 1 of data.
    const link = ws.getCell("A6").value as ExcelJS.CellHyperlinkValue;
    expect(link).toMatchObject({ text: "Systecon Group AB", hyperlink: "https://valstone.my.salesforce.com/001A" });
    expect(ws.getCell("C6").value).toEqual(new Date(Date.UTC(2026, 10, 18)));
    expect(ws.getCell("C6").numFmt).toBe("yyyy-mm-dd");
    expect(ws.getCell("D6").font?.color?.argb).toMatch(/C0392B$/);
    expect(ws.getCell("E6").value).toBe(1970);
    expect(ws.getCell("F6").value).toBe(63);
    expect(ws.getCell("F6").numFmt).toBe("#,##0");
    expect(ws.getCell("G6").value).toBe(1500000);
    expect(ws.getCell("H6").value).toBe(0.073);
    expect(ws.getCell("H6").numFmt).toBe("0.0%");
    // Row 2: ISO timestamp is still a date; amber flags; "12.5%" becomes 0.125.
    expect(ws.getCell("C7").value).toEqual(new Date(Date.UTC(2026, 10, 18)));
    expect(ws.getCell("D7").value).toBe("Not set");
    expect(ws.getCell("D7").font?.color?.argb).toMatch(/B45309$/);
    expect(ws.getCell("F7").font?.bold).toBe(true);
    expect(ws.getCell("H7").value).toBe(0.125);
    // Row 3: unsafe link dropped to plain text; junk stays as text instead of breaking.
    expect(ws.getCell("A8").value).toBe("Evil");
    expect(ws.getCell("C8").value).toBe("not a date");
    expect(ws.getCell("E8").value).toBe("n/a");
    expect(ws.getCell("F8").value).toBe(1234);
  });
  it("handles an empty list and several sheets with clashing names", async () => {
    const req = parseExportRequest({ filename: "x", sheets: [{ name: "Same", columns: [{ key: "a", header: "A" }], rows: [] }, { name: "Same", columns: [{ key: "a", header: "A" }], rows: [{ a: "x" }] }] });
    const wb = await reread(await buildWorkbook(req, new Date("2026-07-01T16:30:00Z")));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Same", "Same 2"]);
    // No title or subtitle: the exported line is row 1 and the header row 3.
    expect(wb.getWorksheet("Same")!.getCell("A1").value).toBe("0 rows · exported Jul 1, 2026, 12:30 PM ET");
    expect(wb.getWorksheet("Same 2")!.getCell("A3").value).toBe("A");
  });
});
