import { MailingSend, EngagementEvent, ProspectInfo } from "./outreach-engagements";

// ── Heatmap: day-of-week (0=Sun..6=Sat) × hour (0-23) ────────────────────────

export type HeatmapCell = {
  sent: number;
  replied: number;
  rate: number;         // 0..1, replied / sent
};

export type HeatmapData = {
  cells: HeatmapCell[][]; // cells[dow][hour]
  peak: { dow: number; hour: number; rate: number; sent: number } | null;
  totalSent: number;
  totalReplied: number;
};

// Convert a UTC ISO timestamp to { dow, hour } in Eastern Time (ET).
// ET = UTC-5 or UTC-4 depending on DST. We use Intl to get the correct values.
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
  // Intl returns "24" for midnight in hour12:false; normalize to 0.
  const hour = Math.min(23, parseInt(hrStr, 10) % 24);
  return { dow, hour };
}

export function computeHeatmap(
  sends: MailingSend[],
  events: EngagementEvent[],
  minSendsForRate: number = 5
): HeatmapData {
  // Build empty 7×24 grid
  const cells: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sent: 0, replied: 0, rate: 0 }))
  );

  // Index sends by mailingId so we can match reply events back to the send bucket
  const sendByMailing = new Map<string, MailingSend>();
  for (const s of sends) {
    sendByMailing.set(s.mailingId, s);
    const { dow, hour } = toEtDowHour(s.sentAt);
    cells[dow][hour].sent++;
  }

  // For each reply event, find the mailing → get its send bucket → increment replied
  for (const e of events) {
    if (e.type !== "reply") continue;
    if (!e.mailingId) continue;
    const send = sendByMailing.get(e.mailingId);
    if (!send) continue; // reply to an email we don't have a send record for
    const { dow, hour } = toEtDowHour(send.sentAt);
    cells[dow][hour].replied++;
  }

  // Compute rates + find peak
  let peak: HeatmapData["peak"] = null;
  let totalSent = 0;
  let totalReplied = 0;

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const c = cells[d][h];
      totalSent += c.sent;
      totalReplied += c.replied;
      c.rate = c.sent > 0 ? c.replied / c.sent : 0;
      if (c.sent >= minSendsForRate) {
        if (!peak || c.rate > peak.rate) {
          peak = { dow: d, hour: h, rate: c.rate, sent: c.sent };
        }
      }
    }
  }

  return { cells, peak, totalSent, totalReplied };
}

// ── Multi-open prospects (3+ opens, zero replies) ────────────────────────────

export type MultiOpenProspect = {
  prospectId: string;
  openCount: number;
  lastOpenedAt: string;
};

export function computeMultiOpens(
  events: EngagementEvent[],
  minOpens: number = 3
): MultiOpenProspect[] {
  const openCounts = new Map<string, { count: number; last: string }>();
  const repliedProspects = new Set<string>();

  for (const e of events) {
    if (e.type === "reply") {
      repliedProspects.add(e.prospectId);
    } else if (e.type === "open") {
      const prev = openCounts.get(e.prospectId);
      if (!prev) {
        openCounts.set(e.prospectId, { count: 1, last: e.eventAt });
      } else {
        prev.count++;
        if (e.eventAt > prev.last) prev.last = e.eventAt;
      }
    }
  }

  const result: MultiOpenProspect[] = [];
  for (const [prospectId, info] of openCounts) {
    if (info.count < minOpens) continue;
    if (repliedProspects.has(prospectId)) continue;
    result.push({
      prospectId,
      openCount: info.count,
      lastOpenedAt: info.last,
    });
  }

  result.sort((a, b) => b.openCount - a.openCount);
  return result;
}

// Pair multi-open prospect IDs with resolved contact info.
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
