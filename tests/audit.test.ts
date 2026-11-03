import { describe, expect, it } from "vitest";
import {
  checkColleagueRecipients, checkDuplicateOpenTasks, checkFailedJobs, checkFalseRces,
  checkPrepHistory, checkStuckDrafts, checkWording, speedCheck,
} from "@/lib/audit";

const meta = (o: Record<string, unknown>) => JSON.stringify({ weeklyOutreachMetadata: true, ...o });
const row = (o: Record<string, unknown>) => ({
  id: "r1", account_name: "AssessTech", status: "draft_ready", draft: "Hi Gabriel,\n\nJust checking in.", week_start: "2026-11-02",
  outreach_type: "RCE", source_reference: meta({}), ...o,
}) as never;

describe("weekly check", () => {
  it("flags an unsent RCE draft addressed to a colleague, including the tenant address", () => {
    const items = checkColleagueRecipients([
      row({ source_reference: meta({ recipients: [{ name: "Alexis", email: "alexis@valstonecorp.com" }] }) }),
      row({ id: "r2", account_name: "AgVantage", source_reference: meta({ recipients: [{ name: "Dan", email: "dan@valstonecorporation.onmicrosoft.com" }] }) }),
      row({ id: "r3", account_name: "Okay Co", source_reference: meta({ recipients: [{ name: "G", email: "gabriel@okay.com" }] }) }),
    ]);
    expect(items.map((i) => i.label)).toEqual(["AssessTech", "AgVantage"]);
  });

  it("flags banned wording in unsent drafts and the send queue, not in sent ones", () => {
    const items = checkWording(
      [
        row({ draft: "Hi Lee,\n\nFollowing up on my notes from September." }),
        row({ id: "r2", status: "sent", draft: "Following up on my last note." }),
      ],
      [{ id: "s1", account_name: "Acme", status: "ready", subject: "Valstone / Acme", body: "It fits squarely in our group — thanks.", week_start: "2026-11-02" }],
    );
    expect(items).toHaveLength(2);
    expect(items[0].detail).toContain('"note" for an email');
    expect(items[1].detail).toContain('"squarely"');
    expect(items[1].detail).toContain("a dash");
  });

  it("flags rows marked sent whose Outlook draft is still a draft", () => {
    const rows = [
      row({ status: "sent", account_name: "Deep Excavation", source_reference: meta({ outlookDraftId: "d1" }) }),
      row({ id: "r2", status: "sent", account_name: "Fine Co", source_reference: meta({ outlookDraftId: "d2" }) }),
    ];
    const items = checkStuckDrafts(rows, new Map([["d1", "draft"], ["d2", "sent"]]));
    expect(items.map((i) => i.label)).toEqual(["Deep Excavation"]);
  });

  it("flags RCEs logged by a nudge, and accounts with two open RCE tasks", () => {
    const rces = checkFalseRces(
      [
        { Id: "t1", Subject: "RCE", Type: null, Description: "Hi Marcus,\n\nJust checking in.", AccountId: "001A", LastModifiedDate: "2026-11-02T15:10:00Z", ActivityDate: "2026-11-02", Account: { Name: "PackageX" } },
        { Id: "t2", Subject: "RCE", Type: null, Description: null, AccountId: "001B", LastModifiedDate: "2026-11-02T15:10:00Z", ActivityDate: "2026-11-02", Account: { Name: "Real RCE" } },
      ],
      "https://x.my.salesforce.com",
    );
    expect(rces.map((i) => i.label)).toEqual(["PackageX"]);
    const dupes = checkDuplicateOpenTasks(
      [
        { Id: "o1", AccountId: "001A", Subject: "RCE", ActivityDate: "2026-11-09", Account: { Name: "PackageX" } },
        { Id: "o2", AccountId: "001A", Subject: "RCE", ActivityDate: "2026-12-12", Account: { Name: "PackageX" } },
        { Id: "o3", AccountId: "001B", Subject: "RCE", ActivityDate: "2026-11-09", Account: { Name: "Solo" } },
      ],
      "https://x.my.salesforce.com",
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].detail).toBe("2 open RCE tasks (2026-11-09, 2026-12-12)");
  });

  const job = (o: Record<string, unknown>) => ({ id: "j", kind: "prep", status: "succeeded", label: "Exosite", error: null, result: null, started_at: "2026-11-02T10:00:00Z", completed_at: "2026-11-02T10:01:30Z", created_at: "2026-11-02T10:00:00Z", ...o });

  it("flags call preps without a founding year, and failed jobs", () => {
    const thin = job({ result: { onePager: { companyHistory: "The founding year, founders, and ownership are not available in the supplied evidence." } } });
    const good = job({ id: "j2", label: "Acme", result: { onePager: { companyHistory: "Founded in 2009 in Minneapolis by two engineers." } } });
    expect(checkPrepHistory([thin, good] as never).map((i) => i.label)).toEqual(["Exosite"]);
    expect(checkFailedJobs([job({ status: "failed", kind: "sourcing", error: "Timed out" })] as never)[0].label).toBe("Sourcing: Exosite");
  });

  it("summarises speed and flags slow runs", () => {
    const s = speedCheck([job({}), job({ id: "j2", completed_at: "2026-11-02T10:06:00Z" })] as never);
    expect(s.notes[0]).toBe("Call prep: 2 runs, typical 1m 30s, slowest 6m 0s");
    expect(s.items[0].detail).toBe("1 run over 4m 0s (slowest 6m 0s)");
  });
});
