import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { isAuthenticated } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  currentWeekStart,
  withWeeklyOutreachClientMetadata,
  type WeeklyOutreachItem,
  type WeeklyOutreachStatus,
} from "@/lib/weekly-outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<WeeklyOutreachStatus, string> = {
  queued: "Queued",
  needs_context: "Needs context",
  researching: "Researching",
  draft_ready: "Draft ready",
  approved: "Approved",
  sent: "Sent",
};

function sourceLabel(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function rceStage(item: WeeklyOutreachItem): string {
  if (item.outreach_type !== "RCE" || item.status !== "sent") return "";
  return item.rce_second_sent ? "2nd sent - Complete" : "1st sent - Follow up";
}

function applyTierStyle(cell: ExcelJS.Cell, tier: string | null) {
  const normalized = tier?.trim().toLowerCase();
  const colors: Record<string, { fill: string; font: string }> = {
    gold: { fill: "FFD700", font: "7F6000" },
    silver: { fill: "B7B7B7", font: "FFFFFF" },
    bronze: { fill: "CD7F32", font: "FFFFFF" },
  };
  const color = normalized ? colors[normalized] : undefined;
  if (!color) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color.fill } };
  cell.font = { name: "Aptos", size: 10, color: { argb: color.font } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestedWeek =
    new URL(request.url).searchParams.get("weekStart") ?? currentWeekStart();
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)
    ? requestedWeek
    : currentWeekStart();
  const { data, error } = await getSupabaseAdmin()
    .from("weekly_outreach")
    .select("*")
    .eq("week_start", weekStart)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = ((data ?? []) as WeeklyOutreachItem[]).map((item) =>
    withWeeklyOutreachClientMetadata(item),
  );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Valsoft Corporation";
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet("Weekly Outreach", {
    properties: { defaultRowHeight: 21, tabColor: { argb: "F28C64" } },
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
    },
    views: [{ state: "frozen", xSplit: 3, ySplit: 1, showGridLines: false }],
  });

  worksheet.columns = [
    { header: "Week", key: "week", width: 14 },
    { header: "Type", key: "type", width: 9 },
    { header: "Company", key: "company", width: 31 },
    { header: "Industry", key: "industry", width: 25 },
    { header: "Country", key: "country", width: 18 },
    { header: "City", key: "city", width: 18 },
    { header: "Tier", key: "tier", width: 12 },
    { header: "Subgroup / Sequence", key: "group", width: 28 },
    { header: "Source", key: "source", width: 13 },
    { header: "Status", key: "status", width: 15 },
    { header: "RCE Follow-up", key: "rceStage", width: 22 },
    { header: "Trip / Notes", key: "notes", width: 42 },
  ];

  const header = worksheet.getRow(1);
  header.height = 28;
  header.font = { name: "Aptos Display", size: 10, bold: true, color: { argb: "FFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1B2A4A" } };
  header.alignment = { vertical: "middle", horizontal: "left" };
  header.eachCell((cell) => {
    cell.border = { bottom: { style: "medium", color: { argb: "F28C64" } } };
  });
  worksheet.autoFilter = { from: "A1", to: "L1" };
  worksheet.pageSetup.printTitlesRow = "1:1";

  for (const item of items) {
    const company: ExcelJS.CellValue = item.account_url
      ? { text: item.account_name, hyperlink: item.account_url, tooltip: "Open in Salesforce" }
      : item.account_name;
    const row = worksheet.addRow({
      week: new Date(`${item.week_start}T12:00:00`),
      type: item.outreach_type,
      company,
      industry: item.industry ?? "",
      country: item.country ?? "",
      city: item.city ?? "",
      tier: item.tier ?? "",
      group: item.group_name ?? "",
      source: sourceLabel(item.source),
      status: STATUS_LABELS[item.status],
      rceStage: rceStage(item),
      notes: item.notes ?? "",
    });
    row.height = 22;
    row.font = { name: "Aptos", size: 10, color: { argb: "1B2A4A" } };
    row.alignment = { vertical: "middle" };

    const completed =
      item.status === "sent" &&
      (item.outreach_type !== "RCE" || item.rce_second_sent === true);
    const firstRceSent =
      item.status === "sent" &&
      item.outreach_type === "RCE" &&
      item.rce_second_sent !== true;
    const rowFill = completed ? "D9EAD3" : firstRceSent ? "EDF7EE" : null;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: "hair", color: { argb: "D9E1F2" } } };
      if (rowFill) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowFill } };
      }
    });

    row.getCell("week").numFmt = "m/d/yyyy";
    row.getCell("week").alignment = { horizontal: "center", vertical: "middle" };
    row.getCell("type").alignment = { horizontal: "center", vertical: "middle" };
    row.getCell("type").font = { name: "Aptos", size: 10, bold: true, color: { argb: "F0643B" } };
    row.getCell("company").font = item.account_url
      ? { name: "Aptos", size: 10, color: { argb: "0563C1" }, underline: true }
      : { name: "Aptos", size: 10, color: { argb: "1B2A4A" } };
    row.getCell("notes").alignment = { vertical: "middle", wrapText: true };
    applyTierStyle(row.getCell("tier"), item.tier);
  }

  worksheet.getColumn("week").numFmt = "m/d/yyyy";
  worksheet.getColumn("status").alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getColumn("rceStage").alignment = { horizontal: "center", vertical: "middle" };

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `Weekly Outreach - ${weekStart}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
