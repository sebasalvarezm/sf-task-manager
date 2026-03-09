import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from "docx";

type OnePagerContent = {
  companyName: string;
  whatTheyDo: string;
  customers: string;
  companyHistory: string;
  recentNews: string[];
};

// Sanitize company name for safe file download
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim() || "Company";
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const content = body as OnePagerContent;

  if (!content.companyName) {
    return NextResponse.json(
      { error: "Missing company name" },
      { status: 400 }
    );
  }

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 100 },
            children: [
              new TextRun({
                text: `Call Prep: ${content.companyName}`,
                bold: true,
                size: 36,
                color: "1B2A4A",
              }),
            ],
          }),

          // Subtitle with date
          new Paragraph({
            spacing: { after: 300 },
            children: [
              new TextRun({
                text: `Generated ${today}  |  Valstone Corporation`,
                color: "999999",
                size: 20,
              }),
            ],
          }),

          // Divider line
          new Paragraph({
            spacing: { after: 300 },
            border: {
              bottom: { style: "single" as const, size: 6, color: "E0E0E0" },
            },
            children: [new TextRun({ text: "" })],
          }),

          // Section 1: What They Do
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
            children: [
              new TextRun({
                text: "What They Do",
                bold: true,
                size: 26,
                color: "1B2A4A",
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 300 },
            children: [
              new TextRun({
                text: content.whatTheyDo || "No information available.",
                size: 22,
              }),
            ],
          }),

          // Section 2: Customers & Use Case
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
            children: [
              new TextRun({
                text: "Customers & Use Case",
                bold: true,
                size: 26,
                color: "1B2A4A",
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 300 },
            children: [
              new TextRun({
                text: content.customers || "No information available.",
                size: 22,
              }),
            ],
          }),

          // Section 3: Company History
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
            children: [
              new TextRun({
                text: "Company History",
                bold: true,
                size: 26,
                color: "1B2A4A",
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 300 },
            children: [
              new TextRun({
                text: content.companyHistory || "No information available.",
                size: 22,
              }),
            ],
          }),

          // Section 4: Recent News
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
            children: [
              new TextRun({
                text: "Recent News",
                bold: true,
                size: 26,
                color: "1B2A4A",
              }),
            ],
          }),
          ...(content.recentNews && content.recentNews.length > 0
            ? content.recentNews.map(
                (item) =>
                  new Paragraph({
                    bullet: { level: 0 },
                    spacing: { after: 80 },
                    children: [new TextRun({ text: item, size: 22 })],
                  })
              )
            : [
                new Paragraph({
                  spacing: { after: 200 },
                  children: [
                    new TextRun({
                      text: "No recent news found.",
                      size: 22,
                      italics: true,
                      color: "999999",
                    }),
                  ],
                }),
              ]),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const safeName = sanitizeFilename(content.companyName);

  // Convert Buffer to Uint8Array for NextResponse compatibility
  const uint8 = new Uint8Array(buffer);

  return new NextResponse(uint8, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="Call Prep - ${safeName}.docx"`,
    },
  });
}
