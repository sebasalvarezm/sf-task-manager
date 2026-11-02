/**
 * Parallel FindAll client (https://docs.parallel.ai/findall-api). Thin and
 * typed; every caller passes a FindAllClient so tests and the dry-run checks
 * use a mock and no test can spend money. The real client refuses to run
 * without PARALLEL_API_KEY rather than falling back to fake data.
 */

export type Generator = "preview" | "base" | "core" | "pro";

/** List prices (docs.parallel.ai/getting-started/pricing), Nov 2026. */
export const FINDALL_PRICES: Record<Generator, { fixed: number; perMatch: number }> = {
  preview: { fixed: 0.1, perMatch: 0 },
  base: { fixed: 0.25, perMatch: 0.03 },
  core: { fixed: 2, perMatch: 0.15 },
  pro: { fixed: 10, perMatch: 1 },
};

export type MatchCondition = { name: string; description: string };
export type ExcludeCandidate = { name: string; url: string };

export type CreateRunBody = {
  objective: string;
  entity_type: "companies";
  match_conditions: MatchCondition[];
  generator: Generator;
  match_limit: number;
  exclude_list?: ExcludeCandidate[];
  metadata?: Record<string, string | number | boolean>;
};

export type RunStatus = "queued" | "action_required" | "running" | "completed" | "failed" | "cancelling" | "cancelled";

export type FindAllRun = {
  findall_id: string;
  status: {
    status: RunStatus;
    is_active: boolean;
    metrics?: { generated_candidates_count?: number; matched_candidates_count?: number };
    termination_reason?: string | null;
  };
  generator?: Generator;
};

export type FindAllCandidate = {
  candidate_id: string;
  name: string;
  url: string;
  description?: string;
  match_status: "generated" | "matched" | "unmatched" | "discarded";
  output?: Record<string, { value?: unknown; type?: string; is_matched?: boolean }>;
  basis?: Array<{ field: string; reasoning?: string; citations?: Array<{ url: string; title?: string | null }>; confidence?: string | null }>;
};

export type FindAllResult = { run: FindAllRun; candidates: FindAllCandidate[] };

export interface FindAllClient {
  readonly mock: boolean;
  createRun(body: CreateRunBody): Promise<FindAllRun>;
  extendRun(findallId: string, additionalMatchLimit: number): Promise<FindAllRun>;
  getRun(findallId: string): Promise<FindAllRun>;
  getResult(findallId: string): Promise<FindAllResult>;
}

const BASE = "https://api.parallel.ai/v1beta/findall/runs";

export function realFindAllClient(): FindAllClient {
  const key = process.env.PARALLEL_API_KEY?.trim();
  if (!key) throw new Error("PARALLEL_API_KEY is not set in Vercel. Discovery did not run.");
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "x-api-key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const why = res.status === 402 ? "Parallel account is out of credit" : res.status === 429 ? "Parallel rate limit" : `Parallel ${res.status}`;
      throw new Error(`${why}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  };
  return {
    mock: false,
    createRun: (body) => call<FindAllRun>("", { method: "POST", body: JSON.stringify(body) }),
    extendRun: (id, n) => call<FindAllRun>(`/${encodeURIComponent(id)}/extend`, { method: "POST", body: JSON.stringify({ additional_match_limit: n }) }),
    getRun: (id) => call<FindAllRun>(`/${encodeURIComponent(id)}`),
    getResult: (id) => call<FindAllResult>(`/${encodeURIComponent(id)}/result`),
  };
}

/** A run can be extended only when it stopped because it hit its match limit. */
export function canExtend(run: Pick<FindAllRun, "status"> | null | undefined): boolean {
  if (!run) return false;
  const s = run.status;
  if (s.is_active) return true;
  return s.status === "completed" && s.termination_reason === "match_limit_met";
}

export function isFinished(run: Pick<FindAllRun, "status">): boolean {
  return !run.status.is_active && ["completed", "failed", "cancelled"].includes(run.status.status);
}

/** What a create or extend will cost at most, before it is sent. */
export function projectedCost(generator: Generator, matches: number, newRun: boolean): number {
  const p = FINDALL_PRICES[generator];
  return (newRun ? p.fixed : 0) + p.perMatch * matches;
}

/**
 * In-memory FindAll for tests and local checks. Each run hands out companies
 * from `pool` that are not on its exclude list, `perRun` at a time, and ends
 * with candidates_exhausted when the pool runs out (like a small thesis would).
 */
export function mockFindAllClient(pool: Array<{ name: string; url: string; description?: string }>): FindAllClient & { calls: string[] } {
  type MockRun = { id: string; limit: number; matched: FindAllCandidate[]; excluded: Set<string>; generator: Generator };
  const runs = new Map<string, MockRun>();
  const calls: string[] = [];
  let seq = 0;
  const host = (u: string) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  const fill = (r: MockRun) => {
    const taken = new Set(r.matched.map((c) => host(c.url)));
    for (const p of pool) {
      if (r.matched.length >= r.limit) break;
      const h = host(p.url);
      if (taken.has(h) || r.excluded.has(h)) continue;
      taken.add(h);
      r.matched.push({
        candidate_id: `cand_${r.id}_${r.matched.length}`,
        name: p.name,
        url: p.url,
        description: p.description,
        match_status: "matched",
        output: { own_software: { value: "yes", type: "match_condition", is_matched: true } },
        basis: [{ field: "own_software", reasoning: `${p.name} sells its own software.`, citations: [{ url: p.url, title: p.name }] }],
      });
    }
  };
  const view = (r: MockRun): FindAllRun => ({
    findall_id: r.id,
    generator: r.generator,
    status: {
      status: "completed",
      is_active: false,
      metrics: { generated_candidates_count: r.matched.length * 3, matched_candidates_count: r.matched.length },
      termination_reason: r.generator === "preview" ? "match_limit_met" : r.matched.length >= r.limit ? "match_limit_met" : "candidates_exhausted",
    },
  });
  return {
    mock: true,
    calls,
    async createRun(body) {
      const id = `findall_mock_${++seq}`;
      calls.push(`create ${body.generator} ${body.match_limit} excl=${body.exclude_list?.length ?? 0}`);
      const r: MockRun = { id, limit: body.match_limit, matched: [], excluded: new Set((body.exclude_list ?? []).map((e) => host(e.url))), generator: body.generator };
      runs.set(id, r);
      fill(r);
      return view(r);
    },
    async extendRun(id, n) {
      calls.push(`extend ${id} +${n}`);
      const r = runs.get(id);
      if (!r) throw new Error("Parallel 404: run not found");
      r.limit += n;
      fill(r);
      return view(r);
    },
    async getRun(id) {
      const r = runs.get(id);
      if (!r) throw new Error("Parallel 404: run not found");
      return view(r);
    },
    async getResult(id) {
      const r = runs.get(id);
      if (!r) throw new Error("Parallel 404: run not found");
      return { run: view(r), candidates: r.matched };
    },
  };
}
