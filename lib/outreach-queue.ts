import Anthropic from "@anthropic-ai/sdk";
import {
  fetchAccountsWithEHistory,
  fetchContactsForAccounts,
  SfAccountWithETasks,
  SfETask,
  SfContact,
} from "./salesforce-contacts";
import { getValidCredentials } from "./token-manager";
import {
  findProspectsByEmails,
  getLastSequenceStateByProspect,
} from "./outreach";

// ── Types ────────────────────────────────────────────────────────────────────

export type Bucket = "DUE_2ND_HIT" | "DUE_RESTART" | "RESPONDED" | "NOT_DUE";

export type SequenceHistory = {
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: "complete" | "partial";
  stepsCompleted: number; // 0-5
};

export type RecommendedContact = {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  source: "salesforce" | "web_research";
  sfContactId?: string;
  unverified?: boolean;
};

export type QueueItem = {
  accountId: string;
  accountName: string;
  website: string | null;
  bucket: Bucket;
  lastSequenceEndDate: string | null;
  lastContactHit: { name: string | null; email: string | null } | null;
  sequenceHistory: SequenceHistory[];
  recommendedContacts: RecommendedContact[];
  lastSequenceUsed: {
    sequenceId: string;
    sequenceName: string;
    enrolledAt: string | null;
  } | null;
};

// ── Leadership title matcher ─────────────────────────────────────────────────

const LEADERSHIP_REGEX =
  /founder|co[- ]?founder|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|chief|president|chairman|owner|managing director|\bmd\b/i;

function leadershipRank(title: string | null): number {
  if (!title) return 99;
  const t = title.toLowerCase();
  if (/co[- ]?founder/.test(t)) return 1;
  if (/\bfounder\b/.test(t)) return 1;
  if (/\bceo\b|chief executive/.test(t)) return 2;
  if (/\bpresident\b/.test(t)) return 3;
  if (/\bcto\b|chief technology/.test(t)) return 4;
  if (/\bcoo\b|chief operating/.test(t)) return 4;
  if (/\bcfo\b|chief financial/.test(t)) return 4;
  if (/chief/.test(t)) return 5;
  if (/chairman|owner|managing director|\bmd\b/.test(t)) return 6;
  return 99;
}

// ── Sequence grouping ────────────────────────────────────────────────────────
// Groups an account's E1-E5 tasks by contact (WhoId). Each contact group
// becomes a SequenceHistory entry.

function groupSequences(tasks: SfETask[]): SequenceHistory[] {
  const byWho = new Map<string, SfETask[]>();

  for (const t of tasks) {
    const key = t.WhoId ?? "__unassigned__";
    const arr = byWho.get(key) ?? [];
    arr.push(t);
    byWho.set(key, arr);
  }

  const histories: SequenceHistory[] = [];

  for (const [whoId, groupTasks] of byWho.entries()) {
    // Count completed E-steps (unique Subject_Type__c values that are completed)
    const completedTypes = new Set<string>();
    for (const t of groupTasks) {
      if (t.Status === "Completed" && /^E[1-5]$/.test(t.SubjectType)) {
        completedTypes.add(t.SubjectType);
      }
    }

    const stepsCompleted = completedTypes.size;
    const status: "complete" | "partial" =
      stepsCompleted >= 5 ? "complete" : "partial";

    // Find first and last dates
    const dated = groupTasks
      .filter((t) => t.CompletedDateTime || t.ActivityDate)
      .map((t) => ({
        task: t,
        date: t.CompletedDateTime ?? t.ActivityDate!,
      }))
      .sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );

    const first = dated[0];
    const last = dated[dated.length - 1];
    const firstContact = groupTasks.find((t) => t.WhoName || t.WhoEmail);

    histories.push({
      contactId: whoId === "__unassigned__" ? null : whoId,
      contactName: firstContact?.WhoName ?? null,
      contactEmail: firstContact?.WhoEmail ?? null,
      startedAt: first?.date ?? null,
      endedAt: last?.date ?? null,
      status,
      stepsCompleted,
    });
  }

  // Sort sequences chronologically by start date
  histories.sort((a, b) => {
    if (!a.startedAt) return 1;
    if (!b.startedAt) return -1;
    return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
  });

  return histories;
}

// ── Classification ───────────────────────────────────────────────────────────

function classify(
  _account: SfAccountWithETasks,
  histories: SequenceHistory[]
): Bucket {
  // Note: we intentionally do NOT exclude accounts with Responded__c = 'Yes'
  // or inbound email tasks. Many accounts responded years ago then ghosted,
  // and we want to re-sequence those as fresh attempts.

  const completedSequences = histories.filter((h) => h.status === "complete");

  if (completedSequences.length === 1) {
    // One full E1-E5 done; due for the 2nd back-to-back hit
    return "DUE_2ND_HIT";
  }

  if (completedSequences.length >= 2) {
    // Two or more full sequences done. Check cooldown.
    const lastEnd = completedSequences
      .map((h) => h.endedAt)
      .filter((d): d is string => !!d)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

    if (lastEnd) {
      const daysSince =
        (Date.now() - new Date(lastEnd).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= 60) return "DUE_RESTART";
    }
  }

  return "NOT_DUE";
}

// ── Contact recommendation ──────────────────────────────────────────────────

async function researchContactsViaAI(
  accountName: string,
  website: string | null
): Promise<RecommendedContact[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  if (!website) return [];

  const domain = website
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Based on public information you know, propose up to 3 likely leadership contacts at the company "${accountName}" (website: ${website}).

Focus on founder, co-founder, CEO, President, or other C-suite roles.

For each contact, guess the most likely work email using common patterns like:
- first.last@${domain}
- first@${domain}
- flast@${domain}

Return a JSON array only (no markdown, no explanation), with this shape:
[{"firstName":"...","lastName":"...","title":"...","email":"..."}]

If you can't identify anyone with high confidence, return [].`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    // Strip fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Array<{
      firstName: string;
      lastName: string;
      title: string;
      email: string;
    }>;

    return (parsed ?? []).slice(0, 3).map((p) => ({
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      title: p.title,
      source: "web_research" as const,
      unverified: true,
    }));
  } catch {
    return [];
  }
}

function recommendContactsSync(
  sfContacts: SfContact[],
  histories: SequenceHistory[],
  bucket: Bucket
): RecommendedContact[] {
  // Filter by leadership title
  const leadership = sfContacts.filter((c) =>
    LEADERSHIP_REGEX.test(c.Title ?? "")
  );

  // For DUE_2ND_HIT, exclude contacts already hit in prior sequences
  const alreadyHit = new Set(
    histories.map((h) => h.contactId).filter(Boolean) as string[]
  );

  const eligible =
    bucket === "DUE_2ND_HIT"
      ? leadership.filter((c) => !alreadyHit.has(c.Id))
      : leadership;

  // Rank & map
  return eligible
    .sort((a, b) => leadershipRank(a.Title) - leadershipRank(b.Title))
    .slice(0, 5)
    .map((c) => ({
      firstName: c.FirstName ?? "",
      lastName: c.LastName ?? "",
      email: c.Email ?? "",
      title: c.Title ?? "",
      source: "salesforce" as const,
      sfContactId: c.Id,
    }))
    .filter((c) => c.email);
}

// ── Main entry: build the queue ──────────────────────────────────────────────

export async function buildQueue(): Promise<{
  due_2nd_hit: QueueItem[];
  due_restart: QueueItem[];
  sfInstanceUrl: string | null;
}> {
  // Fetch SF credentials once so we can expose instance_url for account links
  const sfCreds = await getValidCredentials();
  const sfInstanceUrl = sfCreds?.instance_url ?? null;

  const accounts = await fetchAccountsWithEHistory();

  // First pass: classify each account
  type Pending = {
    account: SfAccountWithETasks;
    histories: SequenceHistory[];
    bucket: Bucket;
  };
  const pending: Pending[] = [];

  for (const account of accounts) {
    const histories = groupSequences(account.Tasks);
    const bucket = classify(account, histories);
    if (bucket !== "DUE_2ND_HIT" && bucket !== "DUE_RESTART") continue;
    pending.push({ account, histories, bucket });
  }

  // Batch-fetch all contacts for qualifying accounts in ONE SOQL call
  const qualifyingAccountIds = pending.map((p) => p.account.Id);
  let contactsByAccount = new Map<string, SfContact[]>();
  try {
    contactsByAccount = await fetchContactsForAccounts(qualifyingAccountIds);
  } catch {
    // Non-fatal: we'll just have empty recommendations
    contactsByAccount = new Map();
  }

  // Second pass: build queue items with recommendations
  const items: QueueItem[] = [];

  for (const { account, histories, bucket } of pending) {
    const sfContacts = contactsByAccount.get(account.Id) ?? [];
    const recommendedContacts = recommendContactsSync(
      sfContacts,
      histories,
      bucket
    );

    const lastCompleted = histories
      .filter((h) => h.status === "complete")
      .sort((a, b) => {
        const ae = a.endedAt ? new Date(a.endedAt).getTime() : 0;
        const be = b.endedAt ? new Date(b.endedAt).getTime() : 0;
        return be - ae;
      })[0];

    items.push({
      accountId: account.Id,
      accountName: account.Name,
      website: account.Website,
      bucket,
      lastSequenceEndDate: lastCompleted?.endedAt ?? null,
      lastContactHit: lastCompleted
        ? {
            name: lastCompleted.contactName,
            email: lastCompleted.contactEmail,
          }
        : null,
      sequenceHistory: histories,
      recommendedContacts,
      lastSequenceUsed: null,
    });
  }

  // Enrich with "last Outreach sequence used" for each item's last-contact email
  try {
    const uniqueEmails = Array.from(
      new Set(
        items
          .map((i) => i.lastContactHit?.email?.toLowerCase())
          .filter((e): e is string => !!e)
      )
    );
    if (uniqueEmails.length > 0) {
      const emailToProspectId = await findProspectsByEmails(uniqueEmails);
      const uniqueProspectIds = Array.from(new Set(emailToProspectId.values()));
      const prospectToSeq = await getLastSequenceStateByProspect(
        uniqueProspectIds
      );

      for (const item of items) {
        const email = item.lastContactHit?.email?.toLowerCase();
        if (!email) continue;
        const prospectId = emailToProspectId.get(email);
        if (!prospectId) continue;
        const seq = prospectToSeq.get(prospectId);
        if (!seq) continue;
        item.lastSequenceUsed = {
          sequenceId: seq.sequenceId,
          sequenceName: seq.sequenceName,
          enrolledAt: seq.enrolledAt,
        };
      }
    }
  } catch {
    // Non-fatal: leave lastSequenceUsed as null on all items
  }

  // Sort each bucket oldest-first by last E5 end date (null dates last)
  const sortOldestFirst = (a: QueueItem, b: QueueItem) => {
    const ad = a.lastSequenceEndDate
      ? new Date(a.lastSequenceEndDate).getTime()
      : Infinity;
    const bd = b.lastSequenceEndDate
      ? new Date(b.lastSequenceEndDate).getTime()
      : Infinity;
    return ad - bd;
  };

  const due_2nd_hit = items
    .filter((i) => i.bucket === "DUE_2ND_HIT")
    .sort(sortOldestFirst);
  const due_restart = items
    .filter((i) => i.bucket === "DUE_RESTART")
    .sort(sortOldestFirst);

  return { due_2nd_hit, due_restart, sfInstanceUrl };
}

// ── On-demand AI research for a specific account ────────────────────────────
// Called from a separate endpoint when the user clicks "Research via AI" on a
// row that has no Salesforce leadership contacts. Not part of the initial load.

export async function researchAccount(
  accountName: string,
  website: string | null
): Promise<RecommendedContact[]> {
  return researchContactsViaAI(accountName, website);
}
