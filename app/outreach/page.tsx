"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ── Types ────────────────────────────────────────────────────────────────────

type SequenceHistory = {
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: "complete" | "partial";
  stepsCompleted: number;
  firstE1: {
    taskId: string;
    subject: string;
    description: string | null;
  } | null;
};

type RecommendedContact = {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  source: "salesforce" | "web_research";
  sfContactId?: string;
  unverified?: boolean;
};

type QueueItem = {
  accountId: string;
  accountName: string;
  website: string | null;
  bucket: "DUE_2ND_HIT" | "DUE_RESTART";
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

type Sequence = { id: string; name: string; tags: string[] };
type Mailbox = { id: string; email: string };

type PushResult = {
  outreach_prospect: {
    ok: boolean;
    prospectId?: string;
    created?: boolean;
    error?: string;
  };
  sequence_state: { ok: boolean; id?: string; error?: string };
  mailing_patch: { ok: boolean; patched?: boolean; error?: string };
};

const CDM_SEQUENCES = [
  "[E] - Contractor",
  "[E] - Structure Design/Analysis",
  "[E] - Safety & Compliance",
  "[E] - Bulk Materials",
  "[E] - Mining",
  "[E] - Waste",
  "[E] - Equipment",
  "[E] - Bulk Liquids",
  "[D-E] - Carveout - Construction & Materials",
  "[E] - Forest & Lumber",
];

type GroupName = "CDM" | "Manufacturing" | "Ag" | "Logistics";
const GROUPS: GroupName[] = ["CDM", "Manufacturing", "Ag", "Logistics"];

// ── Component ────────────────────────────────────────────────────────────────

export default function OutreachPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-gray-400 text-sm">Loading…</p>
        </div>
      }
    >
      <OutreachPageContent />
    </Suspense>
  );
}

function OutreachPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [outreachConnected, setOutreachConnected] = useState<boolean | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"DUE_2ND_HIT" | "DUE_RESTART">(
    "DUE_2ND_HIT"
  );
  const [queue, setQueue] = useState<{
    due_2nd_hit: QueueItem[];
    due_restart: QueueItem[];
  }>({ due_2nd_hit: [], due_restart: [] });
  const [sfInstanceUrl, setSfInstanceUrl] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupName>("CDM");

  // Per-account local UI state
  const [selectedContact, setSelectedContact] = useState<
    Record<string, number>
  >({});
  const [selectedSequence, setSelectedSequence] = useState<
    Record<string, string>
  >({});
  const [selectedMailbox, setSelectedMailbox] = useState<
    Record<string, string>
  >({});
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<
    Record<string, PushResult | null>
  >({});

  // ── Clean redirect params ──────────────────────────────────────────────

  useEffect(() => {
    if (searchParams.get("outreach_connected") === "true") {
      router.replace("/outreach");
    }
  }, [searchParams, router]);

  // ── Check connections ──────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const [sfRes, orRes] = await Promise.all([
          fetch("/api/salesforce/status"),
          fetch("/api/outreach/status"),
        ]);
        if (sfRes.ok) {
          const d = await sfRes.json();
          setSfConnected(d.connected);
        }
        if (orRes.ok) {
          const d = await orRes.json();
          setOutreachConnected(d.connected);
        }
      } catch {
        setSfConnected(false);
        setOutreachConnected(false);
      }
    })();
  }, []);

  // ── Load queue ─────────────────────────────────────────────────────────

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/outreach/queue");
      const text = await res.text();
      let data: {
        error?: string;
        due_2nd_hit?: QueueItem[];
        due_restart?: QueueItem[];
        sfInstanceUrl?: string | null;
      } = {};
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON response (likely a 500 HTML error page from Vercel)
        setError(
          `Server error ${res.status}: ${text.slice(0, 400)}${
            text.length > 400 ? "…" : ""
          }`
        );
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(data.error || `Failed to load queue (status ${res.status})`);
        setLoading(false);
        return;
      }
      setQueue({
        due_2nd_hit: data.due_2nd_hit ?? [],
        due_restart: data.due_restart ?? [],
      });
      setSfInstanceUrl(data.sfInstanceUrl ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load queue");
    }
    setLoading(false);
  }, []);

  // ── Load sequences + mailboxes (only if connected) ──────────────────────

  const loadSequencesAndMailboxes = useCallback(async () => {
    try {
      const res = await fetch("/api/outreach/sequences");
      if (res.ok) {
        const d = await res.json();
        setSequences(d.sequences ?? []);
        setMailboxes(d.mailboxes ?? []);
      }
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (sfConnected && outreachConnected) {
      loadQueue();
      loadSequencesAndMailboxes();
    }
  }, [sfConnected, outreachConnected, loadQueue, loadSequencesAndMailboxes]);

  // ── Push action ────────────────────────────────────────────────────────

  async function handlePush(item: QueueItem) {
    const contactIdx = selectedContact[item.accountId] ?? 0;
    const contact = item.recommendedContacts[contactIdx];
    const sequenceId = selectedSequence[item.accountId];
    const sebMailbox = mailboxes.find(
      (m) => m.email === "sebastian@valstonecorp.com"
    );
    const mailboxId = sebMailbox?.id ?? mailboxes[0]?.id ?? "";

    if (!contact || !sequenceId || !mailboxId) {
      alert("Pick a contact and sequence first.");
      return;
    }

    // Find the first complete sequence's E1 subject for auto-fill
    const firstCompleteSeq = item.sequenceHistory.find(
      (h) => h.status === "complete"
    );
    const firstE1Subject = firstCompleteSeq?.firstE1?.subject ?? null;

    setPushingId(item.accountId);
    setPushResult({ ...pushResult, [item.accountId]: null });

    try {
      const res = await fetch("/api/outreach/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: item.accountName,
          contact: {
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: contact.email,
            title: contact.title,
          },
          sequenceId,
          mailboxId,
          firstE1Subject,
        }),
      });
      const data = (await res.json()) as PushResult;
      setPushResult({ ...pushResult, [item.accountId]: data });
    } catch (e: unknown) {
      setPushResult({
        ...pushResult,
        [item.accountId]: {
          outreach_prospect: {
            ok: false,
            error: e instanceof Error ? e.message : "Network error",
          },
          sequence_state: { ok: false, error: "Not attempted" },
          mailing_patch: { ok: false, error: "Not attempted" },
        },
      });
    }
    setPushingId(null);
  }

  // ── Render helpers ─────────────────────────────────────────────────────

  function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }

  const activeItems =
    activeTab === "DUE_2ND_HIT" ? queue.due_2nd_hit : queue.due_restart;

  // ── Connection gate ────────────────────────────────────────────────────

  if (sfConnected === null || outreachConnected === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400 text-sm">Checking connections…</p>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <img
            src="/valstone-logo.png"
            alt="Valstone"
            className="h-8 w-auto rounded"
          />
          <span className="text-sm text-gray-300">Outreach Queue</span>
        </div>
        <a href="/" className="text-gray-300 hover:text-white text-sm">
          ← Back to Home
        </a>
      </header>

      <main className="flex-1 px-8 py-10">
        <div className="max-w-6xl mx-auto">
          {/* Connection pills */}
          <div className="flex flex-wrap gap-2 mb-6">
            {sfConnected ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                Salesforce connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                Salesforce not connected
              </span>
            )}
            {outreachConnected ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                Outreach connected
              </span>
            ) : (
              <a
                href="/api/outreach/connect"
                className="inline-flex items-center gap-1.5 text-xs text-brand-orange bg-orange-50 border border-orange-200 rounded-full px-3 py-1 hover:bg-orange-100"
              >
                Connect Outreach →
              </a>
            )}
          </div>

          {!sfConnected || !outreachConnected ? (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
              <h2 className="text-lg font-semibold text-navy mb-2">
                Connect both Salesforce and Outreach to get started
              </h2>
              <p className="text-sm text-gray-500">
                The queue pulls sequence history from Salesforce and pushes
                prospects into Outreach. Both connections are required.
              </p>
            </div>
          ) : (
            <>
              {/* Stat strip */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
                  <p className="text-xs text-gray-500">Due for 2nd Hit</p>
                  <p className="text-2xl font-semibold text-navy">
                    {queue.due_2nd_hit.length}
                  </p>
                </div>
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
                  <p className="text-xs text-gray-500">Due for Restart (2mo+)</p>
                  <p className="text-2xl font-semibold text-navy">
                    {queue.due_restart.length}
                  </p>
                </div>
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-center">
                  <p className="text-xs text-gray-500">Total</p>
                  <p className="text-2xl font-semibold text-navy">
                    {queue.due_2nd_hit.length + queue.due_restart.length}
                  </p>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setActiveTab("DUE_2ND_HIT")}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    activeTab === "DUE_2ND_HIT"
                      ? "bg-navy text-white"
                      : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
                  }`}
                >
                  Due for 2nd Hit ({queue.due_2nd_hit.length})
                </button>
                <button
                  onClick={() => setActiveTab("DUE_RESTART")}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    activeTab === "DUE_RESTART"
                      ? "bg-navy text-white"
                      : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
                  }`}
                >
                  Due for Restart ({queue.due_restart.length})
                </button>
                <button
                  onClick={loadQueue}
                  className="ml-auto px-3 py-2 text-xs text-gray-500 border border-gray-200 rounded-full hover:bg-gray-50"
                >
                  ↻ Refresh
                </button>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4 text-sm text-red-700">
                  {error}
                </div>
              )}

              {/* Loading */}
              {loading && (
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                  <p className="text-gray-400 text-sm">
                    Loading queue… this may take a minute while we fetch
                    sequences and contacts.
                  </p>
                </div>
              )}

              {/* Empty state */}
              {!loading && activeItems.length === 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                  <p className="text-gray-400 text-sm">
                    No accounts in this bucket right now. Nicely done.
                  </p>
                </div>
              )}

              {/* Account list */}
              <div className="space-y-3">
                {activeItems.map((item) => {
                  const isOpen = expandedId === item.accountId;
                  const contactIdx = selectedContact[item.accountId] ?? 0;
                  const result = pushResult[item.accountId];
                  const sequenceId = selectedSequence[item.accountId] ?? "";
                  const mailboxId =
                    selectedMailbox[item.accountId] ?? mailboxes[0]?.id ?? "";
                  const topPick = item.recommendedContacts[0];

                  return (
                    <div
                      key={item.accountId}
                      className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
                    >
                      {/* Collapsed row */}
                      <button
                        onClick={() =>
                          setExpandedId(isOpen ? null : item.accountId)
                        }
                        className="w-full text-left p-5 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 mb-1 flex-wrap">
                              <h3 className="text-base font-semibold text-navy truncate">
                                {item.accountName}
                              </h3>
                              {item.website && (
                                <a
                                  href={
                                    item.website.startsWith("http")
                                      ? item.website
                                      : `https://${item.website}`
                                  }
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-xs text-gray-400 hover:text-navy truncate"
                                >
                                  {item.website}
                                </a>
                              )}
                              {sfInstanceUrl && (
                                <a
                                  href={`${sfInstanceUrl}/${item.accountId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[10px] text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-full px-2 py-0.5 whitespace-nowrap"
                                >
                                  View in Salesforce ↗
                                </a>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                              <span>
                                Last seq ended:{" "}
                                <span className="text-gray-700">
                                  {fmtDate(item.lastSequenceEndDate)}
                                </span>
                              </span>
                              <span>
                                Last hit:{" "}
                                <span className="text-gray-700">
                                  {item.lastContactHit?.name ?? "—"}
                                </span>
                              </span>
                              <span>
                                Last sequence:{" "}
                                <span className="text-gray-700">
                                  {item.lastSequenceUsed?.sequenceName ?? "—"}
                                </span>
                              </span>
                              {topPick && (
                                <span>
                                  Suggested next:{" "}
                                  <span className="text-navy font-medium">
                                    {topPick.firstName} {topPick.lastName}
                                  </span>{" "}
                                  <span className="text-gray-400">
                                    ({topPick.title})
                                  </span>
                                </span>
                              )}
                            </div>
                          </div>
                          <svg
                            className={`w-5 h-5 text-gray-400 flex-shrink-0 transition-transform ${
                              isOpen ? "rotate-180" : ""
                            }`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        </div>
                      </button>

                      {/* Expanded body */}
                      {isOpen && (
                        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-4">
                          {/* Sequence history */}
                          <div>
                            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                              Sequence history
                            </h4>
                            <div className="space-y-2">
                              {item.sequenceHistory.map((h, idx) => {
                                const isLastContact =
                                  !!h.contactEmail &&
                                  !!item.lastContactHit?.email &&
                                  h.contactEmail.toLowerCase() ===
                                    item.lastContactHit.email.toLowerCase();
                                const sequenceLabel =
                                  isLastContact && item.lastSequenceUsed
                                    ? item.lastSequenceUsed.sequenceName
                                    : null;
                                return (
                                <div
                                  key={idx}
                                  className="flex items-center gap-3 text-sm bg-gray-50 rounded-lg p-3"
                                >
                                  <span className="font-medium text-navy">
                                    {h.contactName ?? "Unknown contact"}
                                  </span>
                                  <span className="text-xs text-gray-500">
                                    {h.contactEmail ?? "—"}
                                  </span>
                                  {sequenceLabel && (
                                    <span className="text-[10px] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                                      via {sequenceLabel}
                                    </span>
                                  )}
                                  <span className="ml-auto flex items-center gap-1">
                                    {[1, 2, 3, 4, 5].map((n) => (
                                      <span
                                        key={n}
                                        className={`w-6 h-6 text-[10px] flex items-center justify-center rounded-full ${
                                          n <= h.stepsCompleted
                                            ? "bg-navy text-white"
                                            : "bg-gray-200 text-gray-500"
                                        }`}
                                      >
                                        E{n}
                                      </span>
                                    ))}
                                  </span>
                                  <span className="text-xs text-gray-500 ml-2">
                                    {fmtDate(h.startedAt)} →{" "}
                                    {fmtDate(h.endedAt)}
                                  </span>
                                </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Contact recommendations */}
                          <div>
                            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                              Recommended next contact
                            </h4>
                            {item.recommendedContacts.length === 0 ? (
                              <p className="text-sm text-gray-400 italic">
                                No leadership contacts found in Salesforce, and
                                web research returned no results.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                {item.recommendedContacts.map((c, idx) => (
                                  <label
                                    key={idx}
                                    className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                                      contactIdx === idx
                                        ? "border-navy bg-blue-50"
                                        : "border-gray-200 hover:bg-gray-50"
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      name={`contact-${item.accountId}`}
                                      checked={contactIdx === idx}
                                      onChange={() =>
                                        setSelectedContact({
                                          ...selectedContact,
                                          [item.accountId]: idx,
                                        })
                                      }
                                      className="mt-1"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-navy">
                                          {c.firstName} {c.lastName}
                                        </span>
                                        {c.source === "salesforce" ? (
                                          <span className="text-[10px] text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                                            ✓ Salesforce
                                          </span>
                                        ) : (
                                          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                                            ⚠ Unverified — web research
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-xs text-gray-500">
                                        {c.title || "—"}
                                      </div>
                                      <div className="text-xs text-gray-600 mt-0.5">
                                        {c.email}
                                      </div>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* First Hit E1 Content (for 2nd-hit reference) */}
                          {item.bucket === "DUE_2ND_HIT" &&
                            (() => {
                              const firstSeq = item.sequenceHistory.find(
                                (h) => h.status === "complete"
                              );
                              return firstSeq?.firstE1 ? (
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                  <h4 className="text-xs font-semibold text-blue-700 uppercase mb-2">
                                    First Hit E1 Content (for reference)
                                  </h4>
                                  <div className="space-y-2">
                                    <div>
                                      <span className="text-[10px] text-blue-600 uppercase font-semibold">
                                        Subject:
                                      </span>
                                      <p className="text-sm text-gray-800 bg-white border border-blue-100 rounded px-3 py-1.5 mt-0.5 select-all">
                                        {firstSeq.firstE1.subject}
                                      </p>
                                    </div>
                                    {firstSeq.firstE1.description && (
                                      <div>
                                        <span className="text-[10px] text-blue-600 uppercase font-semibold">
                                          Body:
                                        </span>
                                        <pre className="text-xs text-gray-700 bg-white border border-blue-100 rounded px-3 py-2 mt-0.5 whitespace-pre-wrap max-h-48 overflow-y-auto select-all">
                                          {firstSeq.firstE1.description}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ) : null;
                            })()}

                          {/* Group selector + Sequence picker */}
                          {item.recommendedContacts.length > 0 && (
                            <div className="space-y-3">
                              <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">
                                  Group
                                </label>
                                <div className="flex gap-2">
                                  {GROUPS.map((g) => (
                                    <button
                                      key={g}
                                      onClick={() => setSelectedGroup(g)}
                                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                                        selectedGroup === g
                                          ? "bg-navy text-white"
                                          : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
                                      }`}
                                    >
                                      {g}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">
                                  Outreach sequence
                                </label>
                                <select
                                  value={sequenceId}
                                  onChange={(e) =>
                                    setSelectedSequence({
                                      ...selectedSequence,
                                      [item.accountId]: e.target.value,
                                    })
                                  }
                                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:border-navy focus:outline-none"
                                >
                                  <option value="">-- Pick a sequence --</option>
                                  {(selectedGroup === "CDM"
                                    ? sequences.filter((s) =>
                                        CDM_SEQUENCES.includes(s.name)
                                      )
                                    : sequences.filter(
                                        (s) =>
                                          s.name.startsWith("[E] ") ||
                                          s.name.startsWith("[D-E] ")
                                      )
                                  ).map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="text-xs text-gray-500">
                                Sending from:{" "}
                                <span className="font-medium text-gray-700">
                                  sebastian@valstonecorp.com
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Draft button + result */}
                          {item.recommendedContacts.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => handlePush(item)}
                                  disabled={
                                    pushingId === item.accountId ||
                                    !sequenceId
                                  }
                                  className="px-5 py-2 bg-navy hover:bg-navy-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                                >
                                  {pushingId === item.accountId
                                    ? "Creating draft…"
                                    : "Create Draft in Outreach"}
                                </button>
                                {result && (
                                  <div className="flex items-center gap-3 text-xs">
                                    <ResultPill
                                      label="Prospect"
                                      ok={result.outreach_prospect.ok}
                                      msg={result.outreach_prospect.error}
                                    />
                                    <ResultPill
                                      label="Sequence"
                                      ok={result.sequence_state.ok}
                                      msg={result.sequence_state.error}
                                    />
                                    <ResultPill
                                      label="Mailing"
                                      ok={result.mailing_patch.ok}
                                      msg={result.mailing_patch.error}
                                    />
                                  </div>
                                )}
                              </div>
                              {result?.sequence_state.ok && (
                                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                                  Draft created (paused) in Outreach. Go to
                                  Outreach to review, edit, and resume when
                                  ready.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function ResultPill({
  label,
  ok,
  msg,
}: {
  label: string;
  ok: boolean;
  msg?: string;
}) {
  return (
    <span
      title={msg ?? ""}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border ${
        ok
          ? "bg-green-50 text-green-700 border-green-200"
          : "bg-red-50 text-red-700 border-red-200"
      }`}
    >
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}
