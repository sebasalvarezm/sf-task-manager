import { getSupabaseAdmin } from "./supabase";
import { isSalesforceId, sfErrorText, sfFetch, sfQuery } from "./sf-query";
import { getValidCredentials } from "./token-manager";
import { mondayOf, montrealToday } from "./scheduled-actions-core";

/**
 * Every account on Weekly Outreach (this week or later, E1 or RCE, however it
 * got there) is owned by Seb in Salesforce (Nov 2026). Runs right after rows
 * are added and every 15 minutes on weekdays with the contact-notes job, so
 * rows from any path are covered. Only the Account owner changes. Capped per
 * run, with a pause switch on the Weekly check page.
 */

export const OWNER_CAP = 100;
const SETTINGS_KEY = "weekly_owner_settings";

export type OwnerRun = { checked: number; changed: Array<{ id: string; name: string; from: string | null }>; failed: Array<{ id: string; name: string; reason: string }>; paused?: boolean };

export async function getOwnerSettings(): Promise<{ paused: boolean }> {
  const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { paused: (data?.value as { paused?: boolean } | undefined)?.paused === true };
}

export async function saveOwnerSettings(paused: boolean): Promise<{ paused: boolean }> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("app_settings").select("key").eq("key", SETTINGS_KEY).maybeSingle();
  const value = { paused };
  const { error } = data
    ? await supabase.from("app_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", SETTINGS_KEY)
    : await supabase.from("app_settings").insert({ key: SETTINGS_KEY, value });
  if (error) throw new Error(error.message);
  return value;
}

export async function claimWeeklyOutreachAccounts(now = new Date()): Promise<OwnerRun> {
  if ((await getOwnerSettings()).paused) return { checked: 0, changed: [], failed: [], paused: true };
  const credentials = await getValidCredentials();
  if (!credentials) throw new Error("NOT_CONNECTED");
  const me = credentials.salesforce_user_id;
  if (!me || !isSalesforceId(me)) throw new Error("No Salesforce user on the connection.");

  const { data, error } = await getSupabaseAdmin()
    .from("weekly_outreach")
    .select("sf_account_id")
    .gte("week_start", mondayOf(montrealToday(now)))
    .limit(2000);
  if (error) throw new Error(error.message);
  const ids = Array.from(new Set(((data ?? []) as Array<{ sf_account_id: string | null }>).map((r) => r.sf_account_id).filter((id): id is string => isSalesforceId(id))));
  const run: OwnerRun = { checked: ids.length, changed: [], failed: [] };
  if (ids.length === 0) return run;

  // Only the ones not already Seb's.
  type Rec = { Id: string; Name: string; OwnerId: string; Owner?: { Name?: string } | null };
  const toClaim: Rec[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map((id) => `'${id}'`).join(",");
    toClaim.push(...(await sfQuery<Rec>(`SELECT Id, Name, OwnerId, Owner.Name FROM Account WHERE Id IN (${chunk}) AND OwnerId != '${me}'`, credentials)));
  }

  for (const acc of toClaim.slice(0, OWNER_CAP)) {
    const res = await sfFetch(
      `/services/data/v62.0/sobjects/Account/${acc.Id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OwnerId: me }) },
      credentials,
    ).catch(() => null);
    if (res && (res.ok || res.status === 204)) run.changed.push({ id: acc.Id, name: acc.Name, from: acc.Owner?.Name ?? null });
    else run.failed.push({ id: acc.Id, name: acc.Name, reason: res ? await sfErrorText(res).catch(() => `HTTP ${res.status}`) : "no answer" });
  }
  if (toClaim.length > OWNER_CAP) run.failed.push({ id: "", name: `${toClaim.length - OWNER_CAP} more`, reason: `over the ${OWNER_CAP}-per-run cap, next run takes them` });
  return run;
}
