// Pure analysis of the outreach_sends table: what predicts a reply?
//
// Deliberately free of Salesforce, Supabase and `@/` imports so it unit-tests
// in isolation. Everything here is plain arithmetic on rows the builder in
// lib/outcomes.ts already assembled.
//
// Honesty rules baked in:
//   • Every rate carries its sample size and a 95% interval (Wilson), so a
//     "60% reply rate" on 5 sends reads as the noise it is.
//   • Sends are split by date: the first 75% is the training set, the last 25%
//     the holdout. A level only "holds" if its lift points the same way in both
//     halves with at least MIN_HOLDOUT sends in the holdout.
//   • A small logistic regression is fit on the training set and scored on the
//     holdout (AUC). That single number says whether the features predict
//     anything at all. 0.5 means no better than a coin flip.

export type SendRow = {
  sent_on: string; // YYYY-MM-DD
  sender: string | null;
  subject_type: string;
  country: string | null;
  employees: number | null;
  founded: number | null;
  industry: string | null;
  prior_sends: number;
  weekday: number | null;
  hour_et: number | null;
  mailing_id: string | null;
  sequence_name: string | null;
  subject: string | null;
  opened: boolean | null;
  replied_at: string | null;
  call_on: string | null;
  /** clean | potential | flagged, from the BS meter rules at build time. */
  quality?: string | null;
};

export type LevelStat = {
  level: string;
  sends: number;
  replies: number;
  calls: number;
  rate: number;
  lift: number; // rate / base rate; 1 = average
  low: number; // Wilson 95% interval
  high: number;
  holdoutSends: number;
  holdoutRate: number | null;
  holds: boolean | null; // null when the holdout is too small to say
  /** Sends to companies that pass all three BS checks, and replies from them. */
  cleanSends: number;
  cleanReplies: number;
  /** Calls that followed a reply: how well answers turn into meetings. */
  callsAfterReply: number;
};

export type FeatureReport = {
  key: string;
  label: string;
  levels: LevelStat[];
  /** How much the reply rate varies across levels with enough data (max minus min rate). */
  spread: number;
};

export type OutcomesReport = {
  builtAt: string;
  sends: number;
  replies: number;
  calls: number;
  /** Reply rate over tracked sends (the ones matched to an Outreach mailing). */
  replyRate: number;
  callRate: number;
  matchedToOutreach: number;
  /** Sends with no Outreach mailing: replies cannot be seen for these, so they sit outside every reply figure. */
  untracked: number;
  qualityMix: { clean: number; potential: number; flagged: number };
  /** Replies from clean companies per 100 tracked sends: the number that rewards quality, not just volume. */
  cleanRepliesPer100: number;
  replyToCall: number;
  firstSend: string | null;
  lastSend: string | null;
  holdoutFrom: string | null;
  features: FeatureReport[];
  model: { auc: number | null; trainSends: number; holdoutSends: number; verdict: string };
  findings: string[] | null;
  /** One row per sender over tracked sends, the honest scorecard. Sorted by clean replies per 100. */
  senders: SenderScore[];
  /** Tracked sends by week (Monday start), for the trend line. Weeks under 20 sends are left out. */
  weekly: WeekPoint[];
};

export type SenderScore = {
  sender: string;
  sends: number;
  cleanShare: number;
  replies: number;
  replyRate: number;
  cleanPer100: number;
  replyToCall: number | null;
  calls: number;
};

export type WeekPoint = { week: string; sends: number; replyRate: number; cleanPer100: number; cleanShare: number };

/** Monday of the ISO week that holds `ymd`. */
export function weekStart(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export const MIN_LEVEL = 20;
export const MIN_HOLDOUT = 30;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Feature definitions ──────────────────────────────────────────────────────

type FeatureDef = { key: string; label: string; of: (r: SendRow) => string | null };

export function employeesBand(n: number | null): string | null {
  if (n == null) return "Unknown";
  if (n < 20) return "Under 20";
  if (n < 50) return "20 to 49";
  if (n < 100) return "50 to 99";
  if (n < 250) return "100 to 249";
  return "250+";
}

export function foundedBand(y: number | null): string | null {
  if (y == null) return "Unknown";
  if (y < 1990) return "Before 1990";
  if (y < 2000) return "1990s";
  if (y < 2010) return "2000s";
  if (y < 2020) return "2010s";
  return "2020 or later";
}

export function hourBand(h: number | null): string | null {
  if (h == null) return null;
  if (h < 8) return "Before 8am";
  if (h < 10) return "8 to 10am";
  if (h < 12) return "10am to noon";
  if (h < 14) return "Noon to 2pm";
  if (h < 17) return "2 to 5pm";
  return "After 5pm";
}

export function subjectLengthBand(s: string | null): string | null {
  if (s == null) return null;
  const n = s.trim().length;
  if (n === 0) return null;
  if (n <= 25) return "Short (25 chars or less)";
  if (n <= 45) return "Medium (26 to 45)";
  return "Long (over 45)";
}

export function priorBand(n: number): string {
  if (n <= 0) return "First contact";
  if (n === 1) return "Contacted once before";
  if (n === 2) return "Contacted twice before";
  return "Contacted 3+ times before";
}

const QUALITY_LABEL: Record<string, string> = { clean: "Clean (passes all 3 checks)", potential: "Potential (fails 1 check)", flagged: "Flagged (fails 2+)" };

export const FEATURES: FeatureDef[] = [
  { key: "quality", label: "Company quality (BS meter)", of: (r) => (r.quality ? QUALITY_LABEL[r.quality] ?? r.quality : "Unknown") },
  { key: "sender", label: "Sender", of: (r) => r.sender ?? "Unknown" },
  { key: "subject_type", label: "Kind of send", of: (r) => r.subject_type },
  { key: "prior", label: "Contact history", of: (r) => priorBand(r.prior_sends) },
  { key: "weekday", label: "Day of week", of: (r) => (r.weekday == null ? null : WEEKDAYS[r.weekday] ?? null) },
  { key: "hour", label: "Time of day (ET)", of: (r) => hourBand(r.hour_et) },
  { key: "country", label: "Country", of: (r) => r.country ?? "Unknown" },
  { key: "employees", label: "Headcount", of: (r) => employeesBand(r.employees) },
  { key: "founded", label: "Founded", of: (r) => foundedBand(r.founded) },
  { key: "industry", label: "Industry (Salesforce)", of: (r) => r.industry ?? "Unknown" },
  { key: "sequence", label: "Outreach sequence", of: (r) => r.sequence_name },
  { key: "subject_len", label: "Subject line length", of: (r) => subjectLengthBand(r.subject) },
  { key: "opened", label: "Opened the email", of: (r) => (r.opened == null ? null : r.opened ? "Opened" : "Never opened") },
];

// ── Statistics ───────────────────────────────────────────────────────────────

/** Wilson score interval for a proportion; narrower and better behaved than the textbook one on small n. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Area under the ROC curve from scores and binary labels (rank based, ties split). */
export function auc(scores: number[], labels: number[]): number | null {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Logistic regression by gradient descent with a little L2, on dense one-hot rows. Small data, no library needed. */
export function fitLogistic(X: number[][], y: number[], opts: { epochs?: number; lr?: number; l2?: number } = {}): number[] {
  const epochs = opts.epochs ?? 300;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const d = X[0]?.length ?? 0;
  const w = new Array(d + 1).fill(0); // last weight is the bias
  const n = X.length;
  if (n === 0) return w;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * row[j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * row[j];
      grad[d] += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (grad[j] / n + l2 * w[j]);
    w[d] -= lr * (grad[d] / n);
  }
  return w;
}

function predict(w: number[], row: number[]): number {
  const d = row.length;
  let z = w[d];
  for (let j = 0; j < d; j++) z += w[j] * row[j];
  return 1 / (1 + Math.exp(-z));
}

// ── Report ───────────────────────────────────────────────────────────────────

const MODEL_FEATURES = ["quality", "sender", "subject_type", "prior", "weekday", "hour", "country", "employees", "founded", "sequence"];

export function buildReport(rows: SendRow[], builtAt = new Date().toISOString()): OutcomesReport {
  const all = [...rows].sort((a, b) => (a.sent_on < b.sent_on ? -1 : a.sent_on > b.sent_on ? 1 : 0));
  // Only sends matched to an Outreach mailing can show a reply, so every reply
  // figure uses that set. Mixing the rest in would drag the average down and
  // make every sequence look twice as good as it is.
  const sorted = all.filter((r) => r.mailing_id);
  const n = sorted.length;
  const replied = (r: SendRow) => (r.replied_at ? 1 : 0);
  const called = (r: SendRow) => (r.call_on ? 1 : 0);
  const clean = (r: SendRow) => (r.quality === "clean" ? 1 : 0);
  const replies = sorted.reduce((s, r) => s + replied(r), 0);
  const calls = all.reduce((s, r) => s + called(r), 0);
  const base = n ? replies / n : 0;
  const splitAt = Math.floor(n * 0.75);
  const train = sorted.slice(0, splitAt);
  const holdout = sorted.slice(splitAt);
  const trainBase = train.length ? train.reduce((s, r) => s + replied(r), 0) / train.length : 0;
  const holdoutBase = holdout.length ? holdout.reduce((s, r) => s + replied(r), 0) / holdout.length : 0;

  type Acc = { sends: number; replies: number; calls: number; hSends: number; hReplies: number; cleanSends: number; cleanReplies: number; callsAfterReply: number };
  const blank = (): Acc => ({ sends: 0, replies: 0, calls: 0, hSends: 0, hReplies: 0, cleanSends: 0, cleanReplies: 0, callsAfterReply: 0 });
  const features: FeatureReport[] = FEATURES.map((f) => {
    const acc = new Map<string, Acc>();
    const add = (r: SendRow, inHoldout: boolean) => {
      const level = f.of(r);
      if (level == null) return;
      const a = acc.get(level) ?? blank();
      a.sends++;
      a.replies += replied(r);
      a.calls += called(r);
      a.cleanSends += clean(r);
      a.cleanReplies += clean(r) && replied(r) ? 1 : 0;
      a.callsAfterReply += replied(r) && called(r) ? 1 : 0;
      if (inHoldout) {
        a.hSends++;
        a.hReplies += replied(r);
      }
      acc.set(level, a);
    };
    for (const r of train) add(r, false);
    for (const r of holdout) add(r, true);
    const levels: LevelStat[] = [...acc.entries()]
      .map(([level, a]) => {
        const rate = a.sends ? a.replies / a.sends : 0;
        const trainSends = a.sends - a.hSends;
        const trainReplies = a.replies - a.hReplies;
        const trainRate = trainSends ? trainReplies / trainSends : null;
        const hRate = a.hSends ? a.hReplies / a.hSends : null;
        let holds: boolean | null = null;
        if (trainRate != null && hRate != null && a.hSends >= MIN_HOLDOUT && trainSends >= MIN_LEVEL && trainBase > 0 && holdoutBase > 0) {
          const up = trainRate >= trainBase;
          holds = up ? hRate >= holdoutBase : hRate <= holdoutBase;
        }
        const ci = wilson(a.replies, a.sends);
        return {
          level,
          sends: a.sends,
          replies: a.replies,
          calls: a.calls,
          rate,
          lift: base ? rate / base : 0,
          low: ci.low,
          high: ci.high,
          holdoutSends: a.hSends,
          holdoutRate: hRate,
          holds,
          cleanSends: a.cleanSends,
          cleanReplies: a.cleanReplies,
          callsAfterReply: a.callsAfterReply,
        };
      })
      .sort((x, y) => y.sends - x.sends);
    const solid = levels.filter((l) => l.sends >= MIN_LEVEL);
    const spread = solid.length >= 2 ? Math.max(...solid.map((l) => l.rate)) - Math.min(...solid.map((l) => l.rate)) : 0;
    return { key: f.key, label: f.label, levels, spread };
  });

  // Logistic model on the training half, scored on the holdout.
  const vocab: string[] = [];
  const index = new Map<string, number>();
  const featureDefs = FEATURES.filter((f) => MODEL_FEATURES.includes(f.key));
  const levelCounts = new Map<string, number>();
  for (const r of train) {
    for (const f of featureDefs) {
      const level = f.of(r);
      if (level == null) continue;
      const k = `${f.key}=${level}`;
      levelCounts.set(k, (levelCounts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, c] of levelCounts) {
    if (c >= MIN_LEVEL) {
      index.set(k, vocab.length);
      vocab.push(k);
    }
  }
  const encode = (r: SendRow): number[] => {
    const row = new Array(vocab.length).fill(0);
    for (const f of featureDefs) {
      const level = f.of(r);
      if (level == null) continue;
      const j = index.get(`${f.key}=${level}`);
      if (j != null) row[j] = 1;
    }
    return row;
  };
  let modelAuc: number | null = null;
  if (vocab.length > 0 && train.length >= 100 && holdout.length >= MIN_HOLDOUT) {
    const w = fitLogistic(train.map(encode), train.map(replied));
    modelAuc = auc(holdout.map((r) => predict(w, encode(r))), holdout.map(replied));
  }
  const verdict =
    modelAuc == null
      ? "Not enough tracked sends to test a model yet."
      : modelAuc >= 0.7
        ? "The facts we know at send time predict replies well. Worth acting on."
        : modelAuc >= 0.6
          ? "Some signal: these facts tilt the odds but don't decide them."
          : "Little to no signal. Who replies looks mostly unrelated to these facts, so keep testing the message itself.";

  const qualityMix = {
    clean: sorted.filter((r) => r.quality === "clean").length,
    potential: sorted.filter((r) => r.quality === "potential").length,
    flagged: sorted.filter((r) => r.quality === "flagged").length,
  };
  const cleanReplies = sorted.reduce((s, r) => s + (clean(r) && replied(r) ? 1 : 0), 0);
  const callsAfterReply = sorted.reduce((s, r) => s + (replied(r) && called(r) ? 1 : 0), 0);

  // Sender scorecard.
  const bySender = new Map<string, { sends: number; clean: number; replies: number; cleanReplies: number; callsAfterReply: number; calls: number }>();
  for (const r of sorted) {
    const k = r.sender ?? "Unknown";
    const a = bySender.get(k) ?? { sends: 0, clean: 0, replies: 0, cleanReplies: 0, callsAfterReply: 0, calls: 0 };
    a.sends++;
    a.clean += clean(r);
    a.replies += replied(r);
    a.cleanReplies += clean(r) && replied(r) ? 1 : 0;
    a.callsAfterReply += replied(r) && called(r) ? 1 : 0;
    a.calls += called(r);
    bySender.set(k, a);
  }
  const senders: SenderScore[] = [...bySender.entries()]
    .filter(([, a]) => a.sends >= MIN_LEVEL)
    .map(([sender, a]) => ({
      sender,
      sends: a.sends,
      cleanShare: a.clean / a.sends,
      replies: a.replies,
      replyRate: a.replies / a.sends,
      cleanPer100: (a.cleanReplies / a.sends) * 100,
      replyToCall: a.replies >= 10 ? a.callsAfterReply / a.replies : null,
      calls: a.calls,
    }))
    .sort((x, y) => y.cleanPer100 - x.cleanPer100);

  // Weekly trend.
  const byWeek = new Map<string, { sends: number; replies: number; cleanReplies: number; clean: number }>();
  for (const r of sorted) {
    const w = weekStart(r.sent_on);
    const a = byWeek.get(w) ?? { sends: 0, replies: 0, cleanReplies: 0, clean: 0 };
    a.sends++;
    a.replies += replied(r);
    a.cleanReplies += clean(r) && replied(r) ? 1 : 0;
    a.clean += clean(r);
    byWeek.set(w, a);
  }
  const weekly: WeekPoint[] = [...byWeek.entries()]
    .filter(([, a]) => a.sends >= MIN_LEVEL)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, a]) => ({ week, sends: a.sends, replyRate: a.replies / a.sends, cleanPer100: (a.cleanReplies / a.sends) * 100, cleanShare: a.clean / a.sends }));

  return {
    builtAt,
    sends: all.length,
    replies,
    calls,
    replyRate: base,
    callRate: all.length ? calls / all.length : 0,
    matchedToOutreach: n,
    untracked: all.length - n,
    qualityMix,
    cleanRepliesPer100: n ? (cleanReplies / n) * 100 : 0,
    replyToCall: replies ? callsAfterReply / replies : 0,
    firstSend: all[0]?.sent_on ?? null,
    lastSend: all[all.length - 1]?.sent_on ?? null,
    holdoutFrom: holdout[0]?.sent_on ?? null,
    features,
    model: { auc: modelAuc, trainSends: train.length, holdoutSends: holdout.length, verdict },
    findings: null,
    senders,
    weekly,
  };
}

/** The levels worth telling a person about: enough data, clearly above or below average, and confirmed on the holdout. */
export function headlineLevels(report: OutcomesReport): Array<{ feature: string; level: string; rate: number; lift: number; sends: number; holds: boolean | null }> {
  const out: Array<{ feature: string; level: string; rate: number; lift: number; sends: number; holds: boolean | null }> = [];
  for (const f of report.features) {
    for (const l of f.levels) {
      if (l.sends < MIN_LEVEL) continue;
      // Interval must clear the base rate on one side: that's the "clearly" test.
      const clear = l.low > report.replyRate || l.high < report.replyRate;
      if (!clear) continue;
      out.push({ feature: f.label, level: l.level, rate: l.rate, lift: l.lift, sends: l.sends, holds: l.holds });
    }
  }
  return out.sort((a, b) => Math.abs(Math.log(b.lift || 1e-9)) - Math.abs(Math.log(a.lift || 1e-9)));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Findings written from the numbers alone. Each one names its figures so a
 * reader can check it against the cards below. Nothing here is guessed.
 */
export function plainFindings(report: OutcomesReport): string[] {
  const out: string[] = [];
  if (report.matchedToOutreach < 100) return out;
  const feat = (key: string) => report.features.find((f) => f.key === key);
  const solid = (f: FeatureReport | undefined) => (f ? f.levels.filter((l) => l.sends >= Math.max(MIN_LEVEL, 50)) : []);

  out.push(
    `Of ${report.sends.toLocaleString()} sequence starts, ${report.matchedToOutreach.toLocaleString()} could be tracked in Outreach. Among those, ${pct(report.replyRate)} got a reply within 45 days and ${pct(report.replyToCall)} of replies turned into a call within 90 days. The ${report.untracked.toLocaleString()} untracked sends (no matching mailing, usually no contact on the Salesforce task) sit outside every reply figure here.`,
  );

  const q = feat("quality");
  const qClean = q?.levels.find((l) => l.level.startsWith("Clean"));
  const qFlag = q?.levels.find((l) => l.level.startsWith("Flagged"));
  const qPot = q?.levels.find((l) => l.level.startsWith("Potential"));
  if (qClean && qClean.sends >= 50) {
    const share = report.matchedToOutreach ? qClean.sends / report.matchedToOutreach : 0;
    const parts = [`${pct(share)} of tracked sends went to clean companies (pass all three BS checks), and those replied at ${pct(qClean.rate)}`];
    if (qPot && qPot.sends >= 50) parts.push(`potential companies at ${pct(qPot.rate)}`);
    if (qFlag && qFlag.sends >= 50) parts.push(`flagged companies at ${pct(qFlag.rate)}`);
    const flaggedHigher = qFlag && qFlag.sends >= 50 && qFlag.rate > qClean.rate * 1.15;
    out.push(`${parts.join(", ")}. ${flaggedHigher ? "Flagged companies answer more readily, so a raw reply rate flatters anyone emailing outside the target profile. Judge sequences and senders on clean replies per 100 sends, shown on each row." : "Quality and reply rate move together here, so the raw rates are not being propped up by off-profile companies."}`);
  }

  const seq = solid(feat("sequence")).filter((l) => l.cleanSends >= 30);
  if (seq.length >= 3) {
    const byClean = [...seq].sort((a, b) => b.cleanReplies / b.sends - a.cleanReplies / a.sends);
    const top = byClean.slice(0, 3);
    const bottom = byClean.slice(-2);
    const fmt = (l: LevelStat) => `${l.level.replace(/^\[[^\]]*\]\s*-?\s*/, "")} (${((l.cleanReplies / l.sends) * 100).toFixed(1)} clean replies per 100 sends, ${pct(l.rate)} raw${l.holds === true ? ", held this summer" : l.holds === false ? ", slipped this summer" : ""})`;
    out.push(`Sequences ranked on replies from clean companies: ${top.map(fmt).join("; ")} lead. ${bottom.map(fmt).join("; ")} trail. The gap between first and last is ${(((top[0].cleanReplies / top[0].sends) - (bottom[bottom.length - 1].cleanReplies / bottom[bottom.length - 1].sends)) * 100).toFixed(1)} clean replies per 100 sends, the largest lever on this page.`);
  }

  const snd = solid(feat("sender")).filter((l) => l.replies >= 20);
  if (snd.length >= 2) {
    const byConv = [...snd].sort((a, b) => b.callsAfterReply / b.replies - a.callsAfterReply / a.replies);
    const byClean = [...snd].sort((a, b) => b.cleanReplies / b.sends - a.cleanReplies / a.sends);
    const best = byConv[0];
    const worst = byConv[byConv.length - 1];
    out.push(`On turning answers into meetings, ${best.level} converts ${pct(best.callsAfterReply / best.replies)} of replies to a call versus ${pct(worst.callsAfterReply / worst.replies)} for ${worst.level}. On quality-adjusted volume, ${byClean[0].level} leads with ${((byClean[0].cleanReplies / byClean[0].sends) * 100).toFixed(1)} clean replies per 100 sends${byClean[0].cleanSends / byClean[0].sends < 0.5 ? ` (only ${pct(byClean[0].cleanSends / byClean[0].sends)} of their sends were to clean companies)` : ""}.`);
  }

  const weak: string[] = [];
  for (const key of ["weekday", "hour", "employees", "founded"]) {
    const f = feat(key);
    if (f && f.spread > 0 && f.spread < 0.04 && solid(f).length >= 3) weak.push(f.label.toLowerCase());
  }
  if (weak.length) out.push(`${weak.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(", ")} barely move the reply rate (under 4 points between best and worst). Not worth optimising; spend the effort on which companies get the email and what it says.`);

  if (report.model.auc != null) out.push(`Predictability check on sends after ${report.holdoutFrom}: ${report.model.auc.toFixed(2)} (0.5 is a coin flip). ${report.model.verdict}`);
  return out;
}
