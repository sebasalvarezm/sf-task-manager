"use client";

import { HeatmapData } from "@/lib/analytics-derivations";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Business hours the team actually sends during.
const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

function hourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// Map a reply rate (0..1) + volume to a Tailwind bg class.
// Below the volume threshold: neutral gray. Above: blue scale.
function cellClass(
  sent: number,
  rate: number,
  peakRate: number,
  minSends: number
): string {
  if (sent === 0) return "bg-gray-50";
  if (sent < minSends) return "bg-gray-100";
  if (peakRate <= 0) return "bg-blue-50";

  const ratio = rate / peakRate; // 0..1
  if (ratio >= 0.9) return "bg-blue-600 text-white";
  if (ratio >= 0.7) return "bg-blue-500 text-white";
  if (ratio >= 0.5) return "bg-blue-400 text-white";
  if (ratio >= 0.3) return "bg-blue-300";
  if (ratio >= 0.1) return "bg-blue-200";
  return "bg-blue-100";
}

type Props = {
  data: HeatmapData;
  minSendsForRate?: number;
};

export default function Heatmap({ data, minSendsForRate = 5 }: Props) {
  const peakRate = data.peak?.rate ?? 0;

  return (
    <div className="w-full">
      {data.peak && (
        <p className="text-sm font-semibold text-green-600 mb-3">
          Peak: {DAY_LABELS[data.peak.dow]} {hourLabel(data.peak.hour)} —{" "}
          {(data.peak.rate * 100).toFixed(1)}% reply rate ({data.peak.sent} sent)
        </p>
      )}
      <p className="text-xs text-gray-500 mb-3">
        Cell color = reply rate · Number = reply % · Hover for details · Cells with &lt;{minSendsForRate} sends are neutral
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-separate" style={{ borderSpacing: "2px" }}>
          <thead>
            <tr>
              <th className="w-12 text-left text-gray-500 font-medium px-1">Hour</th>
              {DAY_LABELS.map((d) => (
                <th key={d} className="text-gray-500 font-medium px-1 py-1">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOURS.map((h) => (
              <tr key={h}>
                <td className="text-gray-500 font-medium pr-2 text-right whitespace-nowrap">
                  {hourLabel(h)}
                </td>
                {DAY_LABELS.map((_, dow) => {
                  const c = data.cells[dow][h];
                  const cls = cellClass(c.sent, c.rate, peakRate, minSendsForRate);
                  const title = `${DAY_LABELS[dow]} ${hourLabel(h)} — ${c.sent} sent, ${c.replied} replies (${(c.rate * 100).toFixed(1)}%)`;
                  const showLabel = c.sent >= minSendsForRate;
                  return (
                    <td
                      key={dow}
                      title={title}
                      className={`text-center font-medium rounded transition-colors cursor-default ${cls}`}
                      style={{ height: "28px", minWidth: "54px" }}
                    >
                      {showLabel ? `${(c.rate * 100).toFixed(0)}%` : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 mt-3">
        {data.totalSent.toLocaleString()} sends · {data.totalReplied.toLocaleString()} replies · times shown in Eastern Time
      </p>
    </div>
  );
}
