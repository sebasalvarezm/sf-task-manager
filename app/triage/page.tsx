"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

// ── Types ────────────────────────────────────────────────────────────────────

type ThreadMessage = {
  from: string;
  date: string;
  body: string;
};

type TriageEmail = {
  id: string;
  triage_date: string;
  email_id: string | null;
  sender_name: string;
  sender_email: string | null;
  subject: string;
  priority: "p1" | "p2" | "p3";
  context: string | null;
  flag_note: string | null;
  is_flagged: boolean;
  thread: ThreadMessage[];
  draft: string | null;
  review_status: "pending" | "approved" | "edited" | "rejected" | null;
  edited_draft: string | null;
  reviewed_at: string | null;
  created_at: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export default function TriagePage() {
  const router = useRouter();
  const [emails, setEmails] = useState<TriageEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [activeTab, setActiveTab] = useState<"p1" | "p2" | "p3">("p1");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);

  // ── Fetch triage data ──────────────────────────────────────────────────

  const fetchTriage = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/triage?date=${d}`);
      if (res.ok) {
        const data = await res.json();
        setEmails(data.emails ?? []);
      }
    } catch {
      setEmails([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTriage(date);
  }, [date, fetchTriage]);

  // Check Microsoft connection for send button
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/microsoft/status");
        if (res.ok) {
          const data = await res.json();
          setMsConnected(data.connected);
        }
      } catch {
        setMsConnected(false);
      }
    })();
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────

  async function handleReview(
    id: string,
    status: "approved" | "edited" | "rejected"
  ) {
    const body: Record<string, string> = { id, review_status: status };
    if (status === "edited" && editDrafts[id]) {
      body.edited_draft = editDrafts[id];
    }

    const res = await fetch("/api/triage/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setEmails((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                review_status: status,
                reviewed_at: new Date().toISOString(),
                ...(status === "edited" ? { edited_draft: editDrafts[id] } : {}),
              }
            : e
        )
      );
    }
  }

  async function handleSend(id: string) {
    setSendingId(id);
    try {
      const res = await fetch("/api/triage/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });

      if (res.ok) {
        setEmails((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, review_status: e.edited_draft ? "edited" : "approved", reviewed_at: new Date().toISOString() }
              : e
          )
        );
      } else {
        const data = await res.json();
        alert(data.error || "Failed to send email");
      }
    } catch {
      alert("Failed to send email");
    }
    setSendingId(null);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  const filtered = emails.filter((e) => e.priority === activeTab);

  const counts = {
    p1: emails.filter((e) => e.priority === "p1").length,
    p2: emails.filter((e) => e.priority === "p2").length,
    p3: emails.filter((e) => e.priority === "p3").length,
    flagged: emails.filter((e) => e.is_flagged).length,
    drafts: emails.filter((e) => e.draft).length,
    reviewed: emails.filter(
      (e) => e.review_status && e.review_status !== "pending"
    ).length,
  };

  function navigateDate(offset: number) {
    const d = new Date(date + "T12:00:00");
    d.setDate(d.getDate() + offset);
    setDate(d.toISOString().split("T")[0]);
  }

  // ── Priority styling ──────────────────────────────────────────────────

  const priorityBadge = {
    p1: "bg-red-50 text-red-600 border border-red-200",
    p2: "bg-amber-50 text-amber-600 border border-amber-200",
    p3: "bg-green-50 text-green-600 border border-green-200",
  };

  const priorityLabel = { p1: "P1 — Urgent", p2: "P2 — Important", p3: "P3 — Low" };

  const tabStyle = (tab: "p1" | "p2" | "p3") =>
    activeTab === tab
      ? "px-4 py-2 text-sm font-medium rounded-lg bg-navy text-white"
      : "px-4 py-2 text-sm font-medium rounded-lg text-gray-500 hover:bg-gray-100";

  const reviewBadge = (status: string | null) => {
    if (status === "approved") return "bg-green-50 text-green-600 border border-green-200";
    if (status === "edited") return "bg-blue-50 text-blue-600 border border-blue-200";
    if (status === "rejected") return "bg-red-50 text-red-600 border border-red-200";
    return "";
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* ── Header ──────────────────────────────────────────────────────── */}
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
          <span className="text-sm font-normal text-gray-300">
            Email Triage
          </span>
        </div>
        <button
          onClick={() => router.push("/")}
          className="text-gray-300 hover:text-white text-sm"
        >
          ← Back to Home
        </button>
      </header>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        {/* Date navigation */}
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => navigateDate(-1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-100 text-gray-600"
          >
            ← Previous day
          </button>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-navy">{date}</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {emails.length} emails triaged
            </p>
          </div>
          <button
            onClick={() => navigateDate(1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-100 text-gray-600"
          >
            Next day →
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className={`inline-flex items-center text-xs rounded-full px-3 py-1 ${priorityBadge.p1}`}>
            P1: {counts.p1}
          </span>
          <span className={`inline-flex items-center text-xs rounded-full px-3 py-1 ${priorityBadge.p2}`}>
            P2: {counts.p2}
          </span>
          <span className={`inline-flex items-center text-xs rounded-full px-3 py-1 ${priorityBadge.p3}`}>
            P3: {counts.p3}
          </span>
          {counts.flagged > 0 && (
            <span className="inline-flex items-center text-xs rounded-full px-3 py-1 bg-violet-50 text-violet-600 border border-violet-200">
              Flagged: {counts.flagged}
            </span>
          )}
          <span className="inline-flex items-center text-xs rounded-full px-3 py-1 bg-gray-100 text-gray-600">
            Drafts: {counts.drafts}
          </span>
        </div>

        {/* Progress bar */}
        {counts.drafts > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>
                {counts.reviewed} of {counts.drafts} drafts reviewed
              </span>
              <span>
                {Math.round((counts.reviewed / counts.drafts) * 100)}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all"
                style={{
                  width: `${Math.round((counts.reviewed / counts.drafts) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
          <button className={tabStyle("p1")} onClick={() => setActiveTab("p1")}>
            P1 ({counts.p1})
          </button>
          <button className={tabStyle("p2")} onClick={() => setActiveTab("p2")}>
            P2 ({counts.p2})
          </button>
          <button className={tabStyle("p3")} onClick={() => setActiveTab("p3")}>
            P3 ({counts.p3})
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center py-12 text-gray-400">Loading...</div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-400 text-sm">
              No {priorityLabel[activeTab]} emails for this date.
            </p>
          </div>
        )}

        {/* Email cards */}
        {!loading &&
          filtered.map((email) => {
            const isExpanded = expandedId === email.id;
            const isReviewed =
              email.review_status && email.review_status !== "pending";
            const currentDraft =
              editDrafts[email.id] ?? email.edited_draft ?? email.draft ?? "";

            return (
              <div
                key={email.id}
                className="bg-white rounded-2xl border border-gray-200 shadow-sm mb-4 overflow-hidden"
              >
                {/* ── Card header (always visible) ───────────────────────── */}
                <button
                  onClick={() =>
                    setExpandedId(isExpanded ? null : email.id)
                  }
                  className="w-full text-left px-6 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span
                        className={`text-xs font-medium rounded-full px-2 py-0.5 ${priorityBadge[email.priority]}`}
                      >
                        {email.priority.toUpperCase()}
                      </span>
                      {email.is_flagged && (
                        <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-violet-50 text-violet-600 border border-violet-200">
                          Flagged
                        </span>
                      )}
                      {isReviewed && (
                        <span
                          className={`text-xs font-medium rounded-full px-2 py-0.5 ${reviewBadge(email.review_status)}`}
                        >
                          {email.review_status === "approved"
                            ? "Approved"
                            : email.review_status === "edited"
                            ? "Edited"
                            : "Rejected"}
                        </span>
                      )}
                      {!email.draft && (
                        <span className="text-xs text-gray-400">
                          No draft
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-navy truncate">
                      {email.subject}
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      From: {email.sender_name}
                      {email.sender_email && (
                        <span className="text-gray-400">
                          {" "}
                          ({email.sender_email})
                        </span>
                      )}
                    </p>
                    {email.context && (
                      <p className="text-xs text-gray-400 mt-1 italic">
                        {email.context}
                      </p>
                    )}
                  </div>
                  <svg
                    className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 mt-1 ${
                      isExpanded ? "rotate-180" : ""
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
                </button>

                {/* ── Expanded content ────────────────────────────────────── */}
                {isExpanded && (
                  <div className="px-6 pb-6 border-t border-gray-100">
                    {/* Flag note */}
                    {email.is_flagged && email.flag_note && (
                      <div className="mt-4 p-3 rounded-xl bg-violet-50 border border-violet-200">
                        <p className="text-xs font-medium text-violet-700 mb-1">
                          Flag Note
                        </p>
                        <p className="text-sm text-violet-600">
                          {email.flag_note}
                        </p>
                      </div>
                    )}

                    {/* Thread */}
                    {email.thread && email.thread.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-500 mb-2">
                          Thread ({email.thread.length} messages)
                        </p>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {email.thread.map((msg, i) => (
                            <div
                              key={i}
                              className="p-3 rounded-xl bg-gray-50 border border-gray-100"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-medium text-navy">
                                  {msg.from}
                                </span>
                                {msg.date && (
                                  <span className="text-xs text-gray-400">
                                    {msg.date}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-600 whitespace-pre-wrap">
                                {msg.body}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Draft editor */}
                    {email.draft && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-500 mb-2">
                          Draft Reply
                        </p>
                        <textarea
                          className="w-full p-3 rounded-xl border border-gray-200 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy resize-y min-h-[120px]"
                          rows={6}
                          value={currentDraft}
                          onChange={(e) =>
                            setEditDrafts((prev) => ({
                              ...prev,
                              [email.id]: e.target.value,
                            }))
                          }
                          disabled={!!isReviewed}
                        />

                        {/* Action buttons */}
                        {!isReviewed ? (
                          <div className="flex items-center gap-2 mt-3">
                            {/* Send & Approve */}
                            {msConnected && email.sender_email && (
                              <button
                                onClick={() => handleSend(email.id)}
                                disabled={sendingId === email.id}
                                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-orange text-white hover:bg-brand-orange-hover transition-colors disabled:opacity-50"
                              >
                                {sendingId === email.id
                                  ? "Sending..."
                                  : "Send Reply"}
                              </button>
                            )}

                            {/* Approve without sending */}
                            <button
                              onClick={() => handleReview(email.id, "approved")}
                              className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
                            >
                              Approve
                            </button>

                            {/* Save edit */}
                            {editDrafts[email.id] &&
                              editDrafts[email.id] !== (email.edited_draft ?? email.draft) && (
                                <button
                                  onClick={() =>
                                    handleReview(email.id, "edited")
                                  }
                                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                                >
                                  Save Edit
                                </button>
                              )}

                            {/* Reject */}
                            <button
                              onClick={() =>
                                handleReview(email.id, "rejected")
                              }
                              className="px-4 py-2 text-sm font-medium rounded-lg text-red-600 border border-red-200 hover:bg-red-50 transition-colors"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mt-3">
                            <span
                              className={`text-xs font-medium rounded-full px-3 py-1 ${reviewBadge(email.review_status)}`}
                            >
                              {email.review_status === "approved"
                                ? "Approved"
                                : email.review_status === "edited"
                                ? "Edited & Saved"
                                : "Rejected"}
                            </span>
                            {/* Allow sending even after approval */}
                            {msConnected &&
                              email.sender_email &&
                              email.review_status !== "rejected" && (
                                <button
                                  onClick={() => handleSend(email.id)}
                                  disabled={sendingId === email.id}
                                  className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-orange text-white hover:bg-brand-orange-hover transition-colors disabled:opacity-50"
                                >
                                  {sendingId === email.id
                                    ? "Sending..."
                                    : "Send Reply"}
                                </button>
                              )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* No-draft flagged item */}
                    {!email.draft && email.is_flagged && (
                      <div className="mt-4 p-3 rounded-xl bg-gray-50 border border-gray-100">
                        <p className="text-xs text-gray-500 italic">
                          This email was flagged for your attention but no draft
                          reply was generated. Review the thread above and reply
                          manually if needed.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </main>
    </div>
  );
}
