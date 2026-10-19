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
  replyRate: number;
  callRate: number;
  matchedToOutreach: number;
  firstSend: string | null;
  lastSend: string | null;
  holdoutFrom: string | null;
  features: FeatureReport[];
  model: { auc: number | null; trainSends: number; holdoutSends: number; verdict: string };
  findings: string[] | null;
};

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

export const FEATURES: FeatureDef[] = [
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

const MODEL_FEATURES = ["sender", "subject_type", "prior", "weekday", "hour", "country", "employees", "founded"];

export function buildReport(rows: SendRow[], builtAt = new Date().toISOString()): OutcomesReport {
  const sorted = [...rows].sort((a, b) => (a.sent_on < b.sent_on ? -1 : a.sent_on > b.sent_on ? 1 : 0));
  const n = sorted.length;
  const replied = (r: SendRow) => (r.replied_at ? 1 : 0);
  const called = (r: SendRow) => (r.call_on ? 1 : 0);
  const replies = sorted.reduce((s, r) => s + replied(r), 0);
  const calls = sorted.reduce((s, r) => s + called(r), 0);
  const base = n ? replies / n : 0;
  const splitAt = Math.floor(n * 0.75);
  const train = sorted.slice(0, splitAt);
  const holdout = sorted.slice(splitAt);
  const holdoutBase = holdout.length ? holdout.reduce((s, r) => s + replied(r), 0) / holdout.length : 0;

  const features: FeatureReport[] = FEATURES.map((f) => {
    const acc = new Map<string, { sends: number; replies: number; calls: number; hSends: number; hReplies: number }>();
    for (const r of train) {
      const level = f.of(r);
      if (level == null) continue;
      const a = acc.get(level) ?? { sends: 0, replies: 0, calls: 0, hSends: 0, hReplies: 0 };
      a.sends++;
      a.replies += replied(r);
      a.calls += called(r);
      acc.set(level, a);
    }
    for (const r of holdout) {
      const level = f.of(r);
      if (level == null) continue;
      const a = acc.get(level) ?? { sends: 0, replies: 0, calls: 0, hSends: 0, hReplies: 0 };
      a.sends++;
      a.replies += replied(r);
      a.calls += called(r);
      a.hSends++;
      a.hReplies += replied(r);
      acc.set(level, a);
    }
    const levels: LevelStat[] = [...acc.entries()]
      .map(([level, a]) => {
        const rate = a.sends ? a.replies / a.sends : 0;
        const trainSends = a.sends - a.hSends;
        const trainReplies = a.replies - a.hReplies;
        const trainRate = trainSends ? trainReplies / trainSends : null;
        const hRate = a.hSends ? a.hReplies / a.hSends : null;
        const trainBase = train.length ? train.reduce((s, r) => s + replied(r), 0) / train.length : 0;
        let holds: boolean | null = null;
        if (trainRate != null && hRate != null && a.hSends >= MIN_HOLDOUT && trainSends >= MIN_LEVEL) {
          const up = trainRate >= trainBase;
          holds = up ? hRate >= holdoutBase : hRate <= holdoutBase;
        }
        const ci = wilson(a.replies, a.sends);
        return { level, sends: a.sends, replies: a.replies, calls: a.calls, rate, lift: base ? rate / base : 0, low: ci.low, high: ci.high, holdoutSends: a.hSends, holdoutRate: hRate, holds };
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
      ? "Not enough sends to test a model yet."
      : modelAuc >= 0.7
        ? "The facts we know at send time predict replies well. Worth acting on."
        : modelAuc >= 0.6
          ? "Some signal: these facts tilt the odds but don't decide them."
          : "Little to no signal. Who replies looks mostly unrelated to these facts, so keep testing the message itself.";

  return {
    builtAt,
    sends: n,
    replies,
    calls,
    replyRate: base,
    callRate: n ? calls / n : 0,
    matchedToOutreach: sorted.filter((r) => r.mailing_id).length,
    firstSend: sorted[0]?.sent_on ?? null,
    lastSend: sorted[n - 1]?.sent_on ?? null,
    holdoutFrom: holdout[0]?.sent_on ?? null,
    features,
    model: { auc: modelAuc, trainSends: train.length, holdoutSends: holdout.length, verdict },
    findings: null,
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
