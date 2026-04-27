import { getSupabaseAdmin } from "./supabase";

export type JobKind =
  | "sourcing"
  | "prep"
  | "task_bulk"
  | "trip_geocode"
  | "trip_search"
  | "calls_log";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobProgress = {
  step?: string;
  pct?: number;
};

export type Job = {
  id: string;
  session_id: string;
  kind: JobKind;
  status: JobStatus;
  label: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: JobProgress | null;
  inngest_run_id: string | null;
  result_route: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  seen_at: string | null;
};

export type CreateJobInput = {
  kind: JobKind;
  input: Record<string, unknown>;
  label?: string | null;
  resultRoute?: string | null;
  sessionId?: string;
};

// Single-user app today — `default` matches the session_id default in the
// jobs table. Wired into the schema so per-user is a one-line change later.
const DEFAULT_SESSION = "default";

export async function createJob(input: CreateJobInput): Promise<Job> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      session_id: input.sessionId ?? DEFAULT_SESSION,
      kind: input.kind,
      status: "queued",
      label: input.label ?? null,
      input: input.input,
      result_route: input.resultRoute ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create job: ${error.message}`);
  return data as Job;
}

export async function markRunning(jobId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark job running: ${error.message}`);
}

export async function markSucceeded(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
      result,
      progress: { pct: 100 },
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark job succeeded: ${error.message}`);
}

export async function markFailed(
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: errorMessage,
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark job failed: ${error.message}`);
}

export async function updateProgress(
  jobId: string,
  progress: JobProgress,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("jobs")
    .update({ progress })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to update progress: ${error.message}`);
}

export async function listJobs(
  sessionId: string = DEFAULT_SESSION,
  limit = 20,
): Promise<Job[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to list jobs: ${error.message}`);
  return (data ?? []) as Job[];
}

export async function getJob(
  jobId: string,
  sessionId: string = DEFAULT_SESSION,
): Promise<Job | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch job: ${error.message}`);
  return (data as Job) ?? null;
}

export async function markAllSeen(
  sessionId: string = DEFAULT_SESSION,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("jobs")
    .update({ seen_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .in("status", ["succeeded", "failed"])
    .is("seen_at", null)
    .select("id");
  if (error) throw new Error(`Failed to mark jobs seen: ${error.message}`);
  return data?.length ?? 0;
}

export function summarize(jobs: Job[]): {
  inProgressCount: number;
  unreadCount: number;
} {
  let inProgressCount = 0;
  let unreadCount = 0;
  for (const j of jobs) {
    if (j.status === "queued" || j.status === "running") inProgressCount++;
    if (
      (j.status === "succeeded" || j.status === "failed") &&
      j.seen_at == null
    ) {
      unreadCount++;
    }
  }
  return { inProgressCount, unreadCount };
}
