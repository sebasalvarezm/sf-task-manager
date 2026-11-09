/**
 * "Will contact this week" in the Salesforce account description.
 *
 * Every E1 in this week's Weekly Outreach gets one line at the top of its
 * account's Description, "2026-11-09: Will contact this week", above two
 * blank lines and everything that was already there (nothing is deleted).
 * The line comes off again, and only that exact line, when:
 *   - the E1 has gone out (Salesforce has a completed E1 task on the account
 *     dated on or after the line, or the row is marked sent with no send
 *     still waiting in Outreach),
 *   - the row is removed from Weekly Outreach, changed to RCE, or moved to
 *     another week (it comes back when that week starts),
 *   - the week ends without the E1 going out.
 *
 * Runs every 15 minutes on weekdays (7am to 8pm Montreal) and right after
 * rows are added or removed. Hard cap of WRITE_CAP Salesforce writes per run;
 * a pause switch (app_settings "contact_notes_settings") stops it. The list of
 * lines it added lives in app_settings "contact_notes", so it only ever
 * removes lines it wrote itself.
 */
import { getSupabaseAdmin } from "./supabase";
import { assertSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";
import { getValidCredentials } from "./token-manager";
import { inngest } from "./inngest/client";
import { mondayOf, montrealToday } from "./scheduled-actions-core";

export const WRITE_CAP = 100;
const STORE_KEY = "contact_notes";
const SETTINGS_KEY = "contact_notes_settings";
/** Salesforce's limit for Account.Description. */
const DESCRIPTION_MAX = 32000;

export type ContactNote = {
  accountId: string;
  accountName: string | null;
  weeklyRowId: string;
  weekStart: string;
  /** The exact line written, e.g. "2026-11-09: Will contact this week". */
  line: string;
  addedAt: string;
  status: "active" | "removed";
  removedAt?: string;
  removedReason?: string;
};

// ── Text (pure) ──────────────────────────────────────────────────────────────

export function noteLine(date: string): string {
  return `${date}: Will contact this week`;
}

const OUR_LINE = /^\d{4}-\d{2}-\d{2}: Will contact this week[ \t]*(\r?\n)*/;

/** The description with the line on top. An older line of ours at the top is replaced, never stacked. */
export function withNote(description: string | null, line: string): string {
  const rest = (description ?? "").replace(OUR_LINE, "").replace(/^\s+$/, "");
  return rest.trim() ? `${line}\n\n\n${rest}` : line;
}

/** The description without that exact line, or null when the line is not at the top (edited by hand: left alone). */
export function withoutNote(description: string | null, line: string): string | null {
  const text = description ?? "";
  if (!text.startsWith(line)) return null;
  const after = text.slice(line.length);
  if (after && !/^[ \t]*(\r?\n|$)/.test(after)) return null; // "...this week, and more" typed by hand
  return after.replace(/^[ \t]*(\r?\n)*/, "");
}

/** The date on the line: the day the row went into Weekly Outreach, or the Monday it moved to. */
export function noteDate(createdAt: string, weekStart: string): string {
  const added = montrealToday(new Date(createdAt));
  return added > weekStart ? added : weekStart;
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function readNotes(): Promise<{ items: ContactNote[]; updatedAt: string | null }> {
  const { data, error } = await getSupabaseAdmin().from("app_settings").select("value, updated_at").eq("key", STORE_KEY).maybeSingle();
  if (error) throw new Error(`Could not read contact notes: ${error.message}`);
  const items = Array.isArray((data?.value as { items?: ContactNote[] } | undefined)?.items) ? (data!.value as { items: ContactNote[] }).items : [];
  return { items, updatedAt: (data?.updated_at as string | undefined) ?? null };
}

/** Read, change, write back only if nobody wrote in between (else redo). Keeps 60 days of history. */
async function updateNotes(change: (items: ContactNote[]) => ContactNote[]): Promise<ContactNote[]> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { items, updatedAt } = await readNotes();
    const next = change(items).filter((n) => n.status === "active" || (n.removedAt ?? n.addedAt) >= cutoff);
    if (updatedAt === null) {
      const { error } = await supabase.from("app_settings").insert({ key: STORE_KEY, value: { items: next } });
      if (!error) return next;
      continue;
    }
    const { data, error } = await supabase
      .from("app_settings")
      .update({ value: { items: next }, updated_at: new Date().toISOString() })
      .eq("key", STORE_KEY)
      .eq("updated_at", updatedAt)
      .select("key");
    if (error) throw new Error(`Could not save contact notes: ${error.message}`);
    if (data && data.length === 1) return next;
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw new Error("Could not save contact notes: the list kept changing.");
}

export async function listContactNotes(): Promise<ContactNote[]> {
  return (await readNotes()).items;
}

export async function getContactNotesSettings(): Promise<{ paused: boolean }> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { paused: (data?.value as { paused?: boolean } | undefined)?.paused === true };
}

export async function saveContactNotesSettings(paused: boolean): Promise<{ paused: boolean }> {
  const { error } = await getSupabaseAdmin().from("app_settings").upsert({ key: SETTINGS_KEY, value: { paused }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return { paused };
}

/** Ask for a run soon (after rows are added or removed). Never throws: the 15-minute run catches up anyway. */
export async function requestContactNotesRun(): Promise<void> {
  await inngest.send({ name: "weekly-outreach/contact-notes", data: {} }).catch(() => undefined);
}

// ── Salesforce ───────────────────────────────────────────────────────────────

async function readDescriptions(accountIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(accountIds)].map((id) => assertSalesforceId(id, "account id"));
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await sfQuery<{ Id: string; Description: string | null }>(
      `SELECT Id, Description FROM Account WHERE Id IN (${ids.slice(i, i + 100).map((id) => `'${id}'`).join(",")})`,
    );
    for (const r of rows) out.set(r.Id, r.Description ?? null);
  }
  return out;
}

async function writeDescription(accountId: string, description: string): Promise<void> {
  const res = await sfFetch(`/services/data/v62.0/sobjects/Account/${assertSalesforceId(accountId, "account id")}`, {
    method: "PATCH",
    body: JSON.stringify({ Description: description }),
  });
  if (!res.ok) throw new Error(await sfErrorText(res));
}

/** Latest completed E1 task date (Montreal) per account, looking back to the given date. */
async function latestE1Since(accountIds: string[], sinceDate: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(accountIds)].map((id) => assertSalesforceId(id, "account id"));
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await sfQuery<{ AccountId: string | null; CreatedDate: string }>(
      `SELECT AccountId, CreatedDate FROM Task WHERE Subject_Type__c = 'E1' AND Status = 'Completed' AND CreatedDate >= ${sinceDate}T00:00:00Z ` +
        `AND AccountId IN (${ids.slice(i, i + 100).map((id) => `'${id}'`).join(",")})`,
    );
    for (const r of rows) {
      if (!r.AccountId) continue;
      const day = montrealToday(new Date(r.CreatedDate));
      if (!out.has(r.AccountId) || out.get(r.AccountId)! < day) out.set(r.AccountId, day);
    }
  }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

type WeeklyRow = { id: string; sf_account_id: string; account_name: string | null; status: string; created_at: string; week_start: string; outreach_type: string };

export type ContactNotesRun = { added: number; removed: number; skipped: string[]; paused?: boolean };

export async function runContactNotes(now = new Date()): Promise<ContactNotesRun> {
  if ((await getContactNotesSettings()).paused) return { added: 0, removed: 0, skipped: [], paused: true };
  if (!(await getValidCredentials())) throw new Error("NOT_CONNECTED");
  const supabase = getSupabaseAdmin();
  const thisMonday = mondayOf(montrealToday(now));
  const run: ContactNotesRun = { added: 0, removed: 0, skipped: [] };
  let writes = 0;

  const active = (await readNotes()).items.filter((n) => n.status === "active");
  const { data: weekData, error } = await supabase
    .from("weekly_outreach")
    .select("id, sf_account_id, account_name, status, created_at, week_start, outreach_type")
    .eq("week_start", thisMonday)
    .eq("outreach_type", "E1");
  if (error) throw new Error(error.message);
  const thisWeek = (weekData ?? []) as WeeklyRow[];

  // Rows behind the lines we wrote, wherever they are now.
  const trackedIds = active.map((n) => n.weeklyRowId);
  const { data: trackedData } = trackedIds.length
    ? await supabase.from("weekly_outreach").select("id, sf_account_id, account_name, status, created_at, week_start, outreach_type").in("id", trackedIds)
    : { data: [] as WeeklyRow[] };
  const tracked = new Map(((trackedData ?? []) as WeeklyRow[]).map((r) => [r.id, r]));

  // Sends still waiting in Outreach: a row marked sent is not out yet while one is scheduled ahead.
  const rowIds = [...new Set([...thisWeek.map((r) => r.id), ...trackedIds])];
  const { data: sendData } = rowIds.length
    ? await supabase.from("e1_sends").select("weekly_outreach_id, scheduled_for, status").in("weekly_outreach_id", rowIds)
    : { data: [] as Array<{ weekly_outreach_id: string; scheduled_for: string | null; status: string }> };
  const waitingSend = new Set(
    ((sendData ?? []) as Array<{ weekly_outreach_id: string; scheduled_for: string | null; status: string }>)
      .filter((s) => s.status === "scheduled" && s.scheduled_for && s.scheduled_for > now.toISOString())
      .map((s) => s.weekly_outreach_id),
  );

  const accounts = [...new Set([...thisWeek.map((r) => r.sf_account_id), ...active.map((n) => n.accountId)])];
  const earliest = [...active.map((n) => n.line.slice(0, 10)), thisMonday].sort()[0];
  const lastE1 = accounts.length ? await latestE1Since(accounts, earliest) : new Map<string, string>();
  // Out = an E1 logged in Salesforce on or after the line's date, or the row marked sent with nothing still waiting.
  const isOut = (row: WeeklyRow | undefined, accountId: string, since: string) =>
    (lastE1.get(accountId) ?? "") >= since || (row?.status === "sent" && !waitingSend.has(row.id));

  // 1. Take lines off.
  const toRemove: Array<{ note: ContactNote; reason: string }> = [];
  for (const note of active) {
    const row = tracked.get(note.weeklyRowId);
    let reason: string | null = null;
    if (!row) reason = "Removed from Weekly Outreach.";
    else if (row.outreach_type !== "E1") reason = "Changed to RCE.";
    else if (isOut(row, note.accountId, note.line.slice(0, 10))) reason = "E1 sent.";
    else if (row.week_start !== thisMonday) reason = row.week_start > thisMonday ? "Moved to a later week." : "The week ended without the E1 going out.";
    if (reason) toRemove.push({ note, reason });
  }
  const descriptions = await readDescriptions([...toRemove.map((r) => r.note.accountId), ...thisWeek.map((r) => r.sf_account_id)]);
  for (const { note, reason } of toRemove) {
    if (writes >= WRITE_CAP) break;
    const current = descriptions.get(note.accountId) ?? null;
    const next = withoutNote(current, note.line);
    try {
      if (next !== null) {
        await writeDescription(note.accountId, next);
        writes++;
        descriptions.set(note.accountId, next);
      }
      const removedAt = new Date().toISOString();
      await updateNotes((items) => items.map((n) => (n.weeklyRowId === note.weeklyRowId && n.status === "active" ? { ...n, status: "removed", removedAt, removedReason: next === null ? `${reason} The line had been edited by hand, so it was left as is.` : reason } : n)));
      run.removed++;
    } catch (err) {
      run.skipped.push(`${note.accountName ?? note.accountId}: ${err instanceof Error ? err.message : "could not update"}`);
    }
  }

  // 2. Put lines on this week's E1s that are not out yet.
  const stillActive = new Set((await readNotes()).items.filter((n) => n.status === "active").map((n) => n.weeklyRowId));
  for (const row of thisWeek) {
    if (writes >= WRITE_CAP) break;
    const date = noteDate(row.created_at, row.week_start);
    if (stillActive.has(row.id) || isOut(row, row.sf_account_id, date)) continue;
    const line = noteLine(date);
    const current = descriptions.get(row.sf_account_id) ?? null;
    const next = withNote(current, line);
    if (next.length > DESCRIPTION_MAX) {
      run.skipped.push(`${row.account_name ?? row.sf_account_id}: description is full`);
      continue;
    }
    try {
      if (next !== current) {
        await writeDescription(row.sf_account_id, next);
        writes++;
        descriptions.set(row.sf_account_id, next);
      }
      const note: ContactNote = { accountId: row.sf_account_id, accountName: row.account_name, weeklyRowId: row.id, weekStart: row.week_start, line, addedAt: new Date().toISOString(), status: "active" };
      await updateNotes((items) => [...items.filter((n) => !(n.weeklyRowId === row.id && n.status === "active")), note]);
      run.added++;
    } catch (err) {
      run.skipped.push(`${row.account_name ?? row.sf_account_id}: ${err instanceof Error ? err.message : "could not update"}`);
    }
  }
  return run;
}
