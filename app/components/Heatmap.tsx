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
// Below the volume threshold: neutral. Above: one hue (--info) at four
// opacity steps; text flips to white only at the top step.
function cellClass(
  sent: number,
  rate: number,
  peakRate: number,
  minSends: number
): string {
  if (sent === 0) return "bg-surface-3 text-ink-secondary";
  if (sent < minSends) return "bg-surface-4 text-ink-secondary";
  if (peakRate <= 0) return "bg-info/15 text-ink";

  const ratio = rate / peakRate; // 0..1
  if (ratio >= 0.75) return "bg-info/85 text-white";
  if (ratio >= 0.5) return "bg-info/60 text-ink";
  if (ratio >= 0.25) return "bg-info/35 text-ink";
  return "bg-info/15 text-ink";
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
        <p className="text-sm text-ink mb-3 tabular-nums">
          Peak: {DAY_LABELS[data.peak.dow]} {hourLabel(data.peak.hour)} —{" "}
          {(data.peak.rate * 100).toFixed(1)}% open rate ({data.peak.sent} sent)
        </p>
      )}
      <p className="text-[13px] text-ink-secondary mb-3">
        Cell color = open rate · Number = open % · Hover for details · Cells with &lt;{minSendsForRate} sends are neutral
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-separate" style={{ borderSpacing: "2px" }}>
          <thead>
            <tr>
              <th className="w-12 text-left text-ink-secondary font-normal px-1">Hour</th>
              {DAY_LABELS.map((d) => (
                <th key={d} className="text-ink-secondary font-normal px-1 py-1">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOURS.map((h) => (
              <tr key={h}>
                <td className="text-ink-secondary font-normal pr-2 text-right whitespace-nowrap tabular-nums">
                  {hourLabel(h)}
                </td>
                {DAY_LABELS.map((_, dow) => {
                  const c = data.cells[dow][h];
                  const cls = cellClass(c.sent, c.rate, peakRate, minSendsForRate);
                  const title = `${DAY_LABELS[dow]} ${hourLabel(h)} — ${c.sent} sent, ${c.opened} opened (${(c.rate * 100).toFixed(1)}%)`;
                  const showLabel = c.sent >= minSendsForRate;
                  return (
                    <td
                      key={dow}
                      title={title}
                      className={`text-center font-normal tabular-nums rounded-sm transition-colors cursor-default ${cls}`}
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

      <p className="text-[13px] text-ink-muted mt-3 tabular-nums">
        {data.totalSent.toLocaleString()} sends · {data.totalOpened.toLocaleString()} opened · times shown in Eastern Time
      </p>
    </div>
  );
}
