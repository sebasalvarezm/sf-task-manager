import { MailingWithEngagement, ProspectInfo } from "./outreach-engagements";

// ── Heatmap: day-of-week (0=Sun..6=Sat) × hour (0-23) ────────────────────────

// Cell uses "opened" as the engagement signal (mailings with openCount > 0).
// Outreach's Mailing resource doesn't carry replyCount, so open rate is the
// most reliable per-mailing engagement metric we can compute.
export type HeatmapCell = {
  sent: number;
  opened: number;
  rate: number;         // 0..1, opened mailings / sent mailings
};

export type HeatmapData = {
  cells: HeatmapCell[][]; // cells[dow][hour]
  peak: { dow: number; hour: number; rate: number; sent: number } | null;
  totalSent: number;
  totalOpened: number;
};

function toEtDowHour(isoUtc: string): { dow: number; hour: number } {
  const d = new Date(isoUtc);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(d);
  const wdStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hrStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = dowMap[wdStr] ?? 0;
  const hour = Math.min(23, parseInt(hrStr, 10) % 24);
  return { dow, hour };
}

export function computeHeatmap(
  mailings: MailingWithEngagement[],
  minSendsForRate: number = 5
): HeatmapData {
  const cells: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sent: 0, opened: 0, rate: 0 }))
  );

  // Each mailing contributes one "sent" + (openCount > 0 ? 1 : 0) "opened"
  // to its send-time bucket. We count "got at least one open" rather than
  // total opens, which is the conventional open-rate denominator.
  for (const m of mailings) {
    const { dow, hour } = toEtDowHour(m.sentAt);
    cells[dow][hour].sent++;
    if (m.openCount > 0) cells[dow][hour].opened++;
  }

  let peak: HeatmapData["peak"] = null;
  let totalSent = 0;
  let totalOpened = 0;

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const c = cells[d][h];
      totalSent += c.sent;
      totalOpened += c.opened;
      c.rate = c.sent > 0 ? c.opened / c.sent : 0;
      if (c.sent >= minSendsForRate) {
        if (!peak || c.rate > peak.rate) {
          peak = { dow: d, hour: h, rate: c.rate, sent: c.sent };
        }
      }
    }
  }

  return { cells, peak, totalSent, totalOpened };
}

// ── Highly engaged prospects: at least one mailing opened 3+ times ───────────
//
// Outreach's openCount attribute is per-mailing — it reflects how many
// times that one email was opened (e.g., Magda Muka's inbox shows a "9"
// eye badge). The warm-prospect signal we want is: any single email
// they got was opened 3 or more times. If a prospect has multiple
// mailings, we keep the mailing with the highest open count.

export type MultiOpenProspect = {
  prospectId: string;
  openCount: number;      // peak openCount on any single mailing
  mailingId: string;      // the mailing that was opened that many times
  sentAt: string;
};

export function computeMultiOpens(
  mailings: MailingWithEngagement[],
  minOpens: number = 3
): MultiOpenProspect[] {
  const bestPerProspect = new Map<string, MultiOpenProspect>();

  for (const m of mailings) {
    if (m.openCount < minOpens) continue;
    const prev = bestPerProspect.get(m.prospectId);
    if (!prev || m.openCount > prev.openCount) {
      bestPerProspect.set(m.prospectId, {
        prospectId: m.prospectId,
        openCount: m.openCount,
        mailingId: m.mailingId,
        sentAt: m.sentAt,
      });
    }
  }

  const result = Array.from(bestPerProspect.values());
  result.sort((a, b) => b.openCount - a.openCount);
  return result;
}

export type EnrichedMultiOpen = MultiOpenProspect & {
  firstName: string;
  lastName: string;
  company: string;
};

export function enrichMultiOpens(
  multi: MultiOpenProspect[],
  info: Map<string, ProspectInfo>
): EnrichedMultiOpen[] {
  return multi.map((m) => {
    const p = info.get(m.prospectId);
    return {
      ...m,
      firstName: p?.firstName ?? "",
      lastName: p?.lastName ?? "",
      company: p?.company ?? "",
    };
  });
}

// ── Conversion rate (E1+RCE1 → C1) ───────────────────────────────────────────

export type ConversionBlock = {
  outreach: number;
  c1: number;
  rate: number;         // 0..1
};

export function computeConversion(outreach: number, c1: number): ConversionBlock {
  return {
    outreach,
    c1,
    rate: outreach > 0 ? c1 / outreach : 0,
  };
}
