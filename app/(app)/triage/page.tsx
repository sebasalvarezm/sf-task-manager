"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Badge } from "@/app/components/ui/Badge";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

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
  /** Set once the reply has gone out (column added Oct 2026; may be absent). */
  sent_at?: string | null;
  created_at: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export default function TriagePage() {
  const [emails, setEmails] = useState<TriageEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [activeTab, setActiveTab] = useState<"p1" | "p2" | "p3">("p1");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

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
        } else {
          // A failed status check means "can't tell": show the connect
          // prompt rather than "Checking connection…" forever.
          setMsConnected(false);
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
              ? {
                  ...e,
                  review_status: e.edited_draft ? "edited" : "approved",
                  reviewed_at: new Date().toISOString(),
                  sent_at: new Date().toISOString(),
                }
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

  async function handleScan() {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/triage/scan", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setScanResult(
          `Triaged ${data.count} emails (P1: ${data.breakdown?.p1 ?? 0}, P2: ${data.breakdown?.p2 ?? 0}, P3: ${data.breakdown?.p3 ?? 0})`
        );
        fetchTriage(date);
      } else {
        setScanResult(data.error || "Scan failed");
      }
    } catch {
      setScanResult("Scan failed — check your connection");
    }
    setScanning(false);
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

  const priorityBadge: Record<"p1" | "p2" | "p3", "danger" | "warn" | "ok"> = {
    p1: "danger",
    p2: "warn",
    p3: "ok",
  };

  const priorityLabel = { p1: "P1 — Urgent", p2: "P2 — Important", p3: "P3 — Low" };

  const tabStyle = (tab: "p1" | "p2" | "p3") =>
    activeTab === tab
      ? "px-3 py-1.5 text-sm rounded-sm bg-navy text-white"
      : "px-3 py-1.5 text-sm rounded-sm text-ink-secondary hover:bg-surface-3";

  const reviewBadge = (status: string | null): "ok" | "info" | "danger" | "neutral" => {
    if (status === "approved") return "ok";
    if (status === "edited") return "info";
    if (status === "rejected") return "danger";
    return "neutral";
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Email triage"
        subtitle={`${emails.length} emails for ${date}`}
        actions={
          <Button onClick={handleScan} disabled={scanning} loading={scanning}>
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        }
      />
      <PageContent>
        {/* Date navigation */}
        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigateDate(-1)}
            leftIcon={<ChevronLeft className="h-4 w-4" strokeWidth={1.5} />}
          >
            Previous day
          </Button>
          <div className="text-center">
            <h2 className="text-base font-normal text-ink tabular-nums">{date}</h2>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigateDate(1)}
            rightIcon={<ChevronRight className="h-4 w-4" strokeWidth={1.5} />}
          >
            Next day
          </Button>
        </div>

        {scanning && (
          <p className="text-sm text-ink-secondary">
            Reading emails, categorizing with AI, drafting replies — this takes ~30 seconds...
          </p>
        )}
        {scanResult && !scanning && (
          <p className="text-sm text-ink-secondary">
            {scanResult}
          </p>
        )}

        {/* Stats bar */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={priorityBadge.p1} size="md">
            P1: {counts.p1}
          </Badge>
          <Badge variant={priorityBadge.p2} size="md">
            P2: {counts.p2}
          </Badge>
          <Badge variant={priorityBadge.p3} size="md">
            P3: {counts.p3}
          </Badge>
          {counts.flagged > 0 && (
            <Badge variant="neutral" size="md">
              Flagged: {counts.flagged}
            </Badge>
          )}
          <Badge variant="neutral" size="md">
            Drafts: {counts.drafts}
          </Badge>
        </div>

        {/* Progress bar */}
        {counts.drafts > 0 && (
          <div>
            <div className="flex items-center justify-between text-xs text-ink-secondary mb-1 tabular-nums">
              <span>
                {counts.reviewed} of {counts.drafts} drafts reviewed
              </span>
              <span>
                {Math.round((counts.reviewed / counts.drafts) * 100)}%
              </span>
            </div>
            <div className="w-full bg-surface-4 rounded-sm h-1.5">
              <div
                className="bg-info h-1.5 rounded-sm transition-all"
                style={{
                  width: `${Math.round((counts.reviewed / counts.drafts) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border border-line rounded-md p-1 w-fit bg-white">
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
          <div className="text-center py-12 text-sm text-ink-secondary">Loading…</div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-ink-secondary text-sm">
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
                className="bg-white rounded-md border border-line overflow-hidden"
              >
                {/* ── Card header (always visible) ───────────────────────── */}
                <button
                  onClick={() =>
                    setExpandedId(isExpanded ? null : email.id)
                  }
                  className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-surface-3 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant={priorityBadge[email.priority]}>
                        {email.priority.toUpperCase()}
                      </Badge>
                      {email.is_flagged && (
                        <Badge variant="neutral">
                          Flagged
                        </Badge>
                      )}
                      {isReviewed && (
                        <Badge variant={reviewBadge(email.review_status)}>
                          {email.review_status === "approved"
                            ? "Approved"
                            : email.review_status === "edited"
                            ? "Edited"
                            : "Rejected"}
                        </Badge>
                      )}
                      {!email.draft && (
                        <span className="text-xs text-ink-muted">
                          No draft
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-medium text-ink truncate">
                      {email.subject}
                    </h3>
                    <p className="text-xs text-ink-secondary mt-0.5">
                      From: {email.sender_name}
                      {email.sender_email && (
                        <span className="text-ink-muted">
                          {" "}
                          ({email.sender_email})
                        </span>
                      )}
                    </p>
                    {email.context && (
                      <p className="text-xs text-ink-muted mt-1">
                        {email.context}
                      </p>
                    )}
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-ink-muted transition-transform flex-shrink-0 mt-1 ${
                      isExpanded ? "rotate-180" : ""
                    }`}
                    strokeWidth={1.5}
                  />
                </button>

                {/* ── Expanded content ────────────────────────────────────── */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-line">
                    {/* Flag note */}
                    {email.is_flagged && email.flag_note && (
                      <div className="mt-4 p-3 rounded-md bg-white border border-line">
                        <p className="text-sm font-medium text-ink mb-1">
                          Flag note
                        </p>
                        <p className="text-sm text-ink-secondary">
                          {email.flag_note}
                        </p>
                      </div>
                    )}

                    {/* Thread */}
                    {email.thread && email.thread.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs text-ink-secondary mb-2">
                          Thread ({email.thread.length} messages)
                        </p>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {email.thread.map((msg, i) => (
                            <div
                              key={i}
                              className="p-3 rounded-md bg-white border border-line"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-medium text-ink">
                                  {msg.from}
                                </span>
                                {msg.date && (
                                  <span className="text-xs text-ink-muted tabular-nums">
                                    {msg.date}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-ink-secondary whitespace-pre-wrap">
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
                        <p className="text-xs text-ink-secondary mb-2">
                          Draft reply
                        </p>
                        <textarea
                          className="w-full p-3 rounded-sm border border-line-strong bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-surface-4 focus:border-ink disabled:bg-surface-3 resize-y min-h-[120px]"
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
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            {/* Send & Approve */}
                            {msConnected && email.sender_email && (
                              <Button
                                variant="secondary"
                                onClick={() => handleSend(email.id)}
                                disabled={sendingId === email.id}
                                loading={sendingId === email.id}
                              >
                                {sendingId === email.id
                                  ? "Sending…"
                                  : "Send reply"}
                              </Button>
                            )}

                            {/* Approve without sending */}
                            <Button
                              variant="secondary"
                              onClick={() => handleReview(email.id, "approved")}
                            >
                              Approve
                            </Button>

                            {/* Save edit */}
                            {editDrafts[email.id] &&
                              editDrafts[email.id] !== (email.edited_draft ?? email.draft) && (
                                <Button
                                  variant="secondary"
                                  onClick={() =>
                                    handleReview(email.id, "edited")
                                  }
                                >
                                  Save edit
                                </Button>
                              )}

                            {/* Reject */}
                            <Button
                              variant="danger"
                              onClick={() =>
                                handleReview(email.id, "rejected")
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            <Badge variant={reviewBadge(email.review_status)} size="md">
                              {email.review_status === "approved"
                                ? "Approved"
                                : email.review_status === "edited"
                                ? "Edited & saved"
                                : "Rejected"}
                            </Badge>
                            {email.sent_at && (
                              <span className="text-xs text-ok">Reply sent</span>
                            )}
                            {/* Allow sending after approval, but only once */}
                            {msConnected &&
                              email.sender_email &&
                              !email.sent_at &&
                              email.review_status !== "rejected" && (
                                <Button
                                  variant="secondary"
                                  onClick={() => handleSend(email.id)}
                                  disabled={sendingId === email.id}
                                  loading={sendingId === email.id}
                                >
                                  {sendingId === email.id
                                    ? "Sending…"
                                    : "Send reply"}
                                </Button>
                              )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* No-draft flagged item */}
                    {!email.draft && email.is_flagged && (
                      <p className="mt-4 text-sm text-ink-secondary">
                        This email was flagged for your attention but no draft
                        reply was generated. Review the thread above and reply
                        manually if needed.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </PageContent>
    </>
  );
}
