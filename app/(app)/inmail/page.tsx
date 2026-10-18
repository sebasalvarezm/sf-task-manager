"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Asterisk, Copy, Check, MessageSquare } from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";
import { Badge } from "@/app/components/ui/Badge";

type Status = "pending" | "generated" | "needs_review" | "sent" | "followup_sent" | "dismissed";

type Row = {
  who_id: string;
  account_id: string | null;
  account_name: string | null;
  contact_name: string | null;
  first_name: string | null;
  contact_email: string | null;
  e5_sent_at: string | null;
  e1_body: string | null;
  linkedin_url: string | null;
  navigator_url: string | null;
  status: Status;
  subject: string | null;
  initial_message: string | null;
  followup_message: string | null;
  flags: string[];
  sent_at: string | null;
  followup_sent_at: string | null;
};

type Filter = "todo" | "followup" | "done" | "all";

const STATUS_LABEL: Record<Status, { label: string; variant: "neutral" | "brand" | "ok" | "warn" | "danger" | "info" }> = {
  pending: { label: "Pending", variant: "neutral" },
  generated: { label: "Ready", variant: "info" },
  needs_review: { label: "Needs a look", variant: "warn" },
  sent: { label: "Sent", variant: "ok" },
  followup_sent: { label: "Follow-up sent", variant: "ok" },
  dismissed: { label: "Dismissed", variant: "neutral" },
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

export default function InMailQueuePage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todo");
  const [days, setDays] = useState(7);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftInitial, setDraftInitial] = useState("");
  const [draftFollowup, setDraftFollowup] = useState("");
  const [copied, setCopied] = useState<"subject" | "initial" | "followup" | null>(null);
  const [copiedRow, setCopiedRow] = useState<string | null>(null);
  // Phones have no Recruiter web app worth opening; the LinkedIn app does open
  // a people search, and the profile page there has "View in Recruiter".
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/inmail");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the queue");
      setItems(data.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the queue");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = openId ? items.find((row) => row.who_id === openId) ?? null : null;
  useEffect(() => {
    if (!open) return;
    setDraftSubject(open.subject ?? "");
    setDraftInitial(open.initial_message ?? "");
    setDraftFollowup(open.followup_message ?? "");
    setCopied(null);
  }, [open?.who_id, open?.subject, open?.initial_message, open?.followup_message]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    return items.filter((row) => {
      if (filter === "all") return true;
      if (filter === "todo") return row.status === "pending" || row.status === "generated" || row.status === "needs_review";
      if (filter === "followup") return row.status === "sent";
      return row.status === "followup_sent";
    });
  }, [items, filter]);

  const counts = useMemo(
    () => ({
      todo: items.filter((r) => ["pending", "generated", "needs_review"].includes(r.status)).length,
      followup: items.filter((r) => r.status === "sent").length,
      followupDue: items.filter((r) => r.status === "sent" && (daysSince(r.sent_at) ?? 0) >= 7).length,
      done: items.filter((r) => r.status === "followup_sent").length,
    }),
    [items],
  );

  function replaceRow(row: Row) {
    setItems((previous) => previous.map((r) => (r.who_id === row.who_id ? row : r)));
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/inmail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      setItems(data.items ?? []);
      const s = data.summary;
      setMessage(
        `Checked ${s.scanned} contact${s.scanned === 1 ? "" : "s"} with an E5 in the last ${days} days: ${s.added} added` +
          (s.skippedReplied ? `, ${s.skippedReplied} replied` : "") +
          (s.skippedActivity ? `, ${s.skippedActivity} had later activity` : "") +
          ".",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function generate(whoId: string) {
    setBusy((prev) => new Set(prev).add(whoId));
    setError(null);
    try {
      const res = await fetch("/api/inmail/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whoId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generate failed");
      replaceRow(data.item);
      setOpenId(whoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(whoId);
        return next;
      });
    }
  }

  async function generateAll() {
    setGeneratingAll(true);
    setError(null);
    try {
      const res = await fetch("/api/inmail/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generate failed");
      setItems(data.items ?? []);
      const ok = (data.results ?? []).filter((r: { ok: boolean }) => r.ok).length;
      const failed = (data.results ?? []).length - ok;
      setMessage(`Generated ${ok} InMail${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generate failed");
    } finally {
      setGeneratingAll(false);
    }
  }

  async function patch(whoId: string, body: Record<string, unknown>) {
    const res = await fetch("/api/inmail", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whoId, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Update failed");
    replaceRow(data.item);
    return data.item as Row;
  }

  async function setStatus(row: Row, status: Status) {
    try {
      await patch(row.who_id, { status });
      if (status === "sent") setMessage(`${row.contact_name ?? "Contact"} marked sent. Follow-up lights up in 7 days.`);
      if (status === "followup_sent") setMessage(`${row.contact_name ?? "Contact"} complete (InMail and scheduled follow-up).`);
      if (status === "followup_sent" && openId === row.who_id) setOpenId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function saveDrafts() {
    if (!open) return;
    try {
      await patch(open.who_id, { subject: draftSubject, initialMessage: draftInitial, followupMessage: draftFollowup });
      setMessage("Edits saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function copy(which: "subject" | "initial" | "followup") {
    const text = which === "subject" ? draftSubject : which === "initial" ? draftInitial : draftFollowup;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Could not copy. Select the text and copy it by hand.");
    }
  }

  const peopleSearchHref = (row: Row) =>
    row.contact_name
      ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([row.contact_name, row.account_name].filter(Boolean).join(" "))}`
      : null;
  // Desktop: Salesforce profile link, else Recruiter search. Phone: profile link, else LinkedIn people search (opens the app).
  const profileHref = (row: Row) => row.linkedin_url ?? (isMobile ? peopleSearchHref(row) : row.navigator_url) ?? null;

  async function copyRowInMail(row: Row) {
    const text = [row.subject, row.initial_message].filter(Boolean).join("\n\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedRow(row.who_id);
      window.setTimeout(() => setCopiedRow((v) => (v === row.who_id ? null : v)), 1500);
    } catch {
      setError("Could not copy. Open the InMail and copy it from there.");
    }
  }

  return (
    <>
      <PageHeader
        title="InMail queue"
        subtitle="Contacts who finished the email sequence without replying. InMails are built from the E1 that was actually sent."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              E5 in last
              <select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                className="h-9 rounded-sm border border-line-strong bg-white px-2 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4"
              >
                {[7, 14, 30, 60].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh from Salesforce
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Asterisk size={16} />}
              loading={generatingAll}
              disabled={!items.some((r) => r.status === "pending" && r.e1_body && r.first_name)}
              onClick={() => void generateAll()}
            >
              Generate all pending
            </Button>
          </div>
        }
      />
      <PageContent>
        {error ? (
          <Alert variant="danger" className="mb-4" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {message ? (
          <div className="mb-4 flex items-start justify-between gap-3 text-sm text-ink-secondary">
            <span>{message}</span>
            <button type="button" onClick={() => setMessage(null)} className="shrink-0 rounded-sm px-1 text-ink-muted hover:bg-surface-3 hover:text-ink" aria-label="Dismiss">
              ×
            </button>
          </div>
        ) : null}

        <div className="mb-4 flex flex-wrap gap-2">
          {(
            [
              ["todo", `To send (${counts.todo})`],
              ["followup", `Manual follow-up (${counts.followup}${counts.followupDue ? `, ${counts.followupDue} due` : ""})`],
              ["done", `Complete (${counts.done})`],
              ["all", "All"],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-sm border px-3 py-1.5 text-sm ${
                filter === key ? "border-navy bg-navy text-white" : "border-line bg-white text-ink-secondary hover:bg-surface-3"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-line bg-white p-8 text-center text-sm text-ink-secondary">
            {items.length === 0
              ? "Nothing queued yet. Click Refresh from Salesforce to pull contacts whose E5 went out recently with no reply."
              : "Nothing in this view."}
          </div>
        ) : (
          <>
          <div className="border-t border-line md:hidden">
            {visible.map((row) => {
              const since = daysSince(row.e5_sent_at ? `${row.e5_sent_at}T12:00:00` : null);
              const sentDays = daysSince(row.sent_at);
              const href = profileHref(row);
              const isBusy = busy.has(row.who_id);
              const canGenerate = row.status === "pending" || row.status === "needs_review";
              return (
                <div key={row.who_id} className="border-b border-line bg-white px-1 py-3 hover:bg-surface-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-ink">{row.contact_name ?? "Unknown contact"}</div>
                      <div className="truncate text-[13px] text-ink-secondary">{row.account_name ?? "—"}</div>
                    </div>
                    <Badge variant={STATUS_LABEL[row.status].variant}>
                      {STATUS_LABEL[row.status].label}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    E5 sent {row.e5_sent_at ?? "—"}{since !== null ? ` (${since}d ago)` : ""}
                    {row.status === "sent" && sentDays !== null ? (
                      <span className={sentDays >= 7 ? " text-ink underline underline-offset-2" : ""}>
                        {" · "}{sentDays >= 7 ? "Follow-up due" : `Follow-up in ${7 - sentDays}d`}
                      </span>
                    ) : null}
                  </div>
                  {row.flags.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-[13px] text-warn">
                      {row.flags.map((flag) => (
                        <li key={flag}>{flag}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {row.initial_message ? (
                      <Button size="sm" leftIcon={copiedRow === row.who_id ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copyRowInMail(row)}>
                        {copiedRow === row.who_id ? "Copied" : "Copy InMail"}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" leftIcon={<Asterisk size={16} />} loading={isBusy} disabled={!canGenerate || !row.e1_body || !row.first_name} onClick={() => void generate(row.who_id)}>
                        Generate
                      </Button>
                    )}
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-line-strong bg-white px-3 text-[13px] font-medium text-ink hover:bg-surface-3 active:bg-surface-4"
                      >
                        <MessageSquare size={16} /> {row.linkedin_url ? "Open profile" : "Find on LinkedIn"}
                      </a>
                    ) : (
                      <span />
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.initial_message ? (
                      <Button size="sm" variant="ghost" onClick={() => setOpenId(row.who_id)}>
                        Open
                      </Button>
                    ) : null}
                    {row.initial_message && canGenerate ? (
                      <Button size="sm" variant="ghost" loading={isBusy} onClick={() => void generate(row.who_id)}>
                        Regenerate
                      </Button>
                    ) : null}
                    {row.status === "generated" || row.status === "needs_review" ? (
                      <Button size="sm" variant="ghost" onClick={() => void setStatus(row, "followup_sent")}>
                        Both sent
                      </Button>
                    ) : null}
                    {row.status === "sent" ? (
                      <Button size="sm" variant="ghost" onClick={() => void setStatus(row, "followup_sent")}>
                        Follow-up sent
                      </Button>
                    ) : null}
                    {row.status !== "dismissed" && row.status !== "followup_sent" ? (
                      <Button size="sm" variant="ghost" className="text-ink-muted" onClick={() => void setStatus(row, "dismissed")}>
                        Dismiss
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden overflow-x-auto rounded-md border border-line bg-white md:block">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-[13px] font-normal text-ink-secondary">
                <tr>
                  <th className="px-4 py-3 font-normal">Contact</th>
                  <th className="px-4 py-3 font-normal">Company</th>
                  <th className="px-4 py-3 font-normal">E5 sent</th>
                  <th className="px-4 py-3 font-normal">Status</th>
                  <th className="px-4 py-3 font-normal">LinkedIn</th>
                  <th className="px-4 py-3 text-right font-normal">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const since = daysSince(row.e5_sent_at ? `${row.e5_sent_at}T12:00:00` : null);
                  const sentDays = daysSince(row.sent_at);
                  const href = profileHref(row);
                  const isBusy = busy.has(row.who_id);
                  return (
                    <tr key={row.who_id} className="border-t border-line align-top hover:bg-surface-3">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{row.contact_name ?? "Unknown contact"}</div>
                        {row.contact_email ? <div className="text-[13px] text-ink-secondary">{row.contact_email}</div> : null}
                        {row.flags.length > 0 ? (
                          <ul className="mt-1 space-y-0.5 text-[13px] text-warn">
                            {row.flags.map((flag) => (
                              <li key={flag}>{flag}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink">{row.account_name ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-ink-secondary">
                        {row.e5_sent_at ?? "—"}
                        {since !== null ? <div className="text-[13px] text-ink-muted">{since}d ago</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_LABEL[row.status].variant}>
                          {STATUS_LABEL[row.status].label}
                        </Badge>
                        {row.status === "sent" && sentDays !== null ? (
                          <div className={`mt-1 text-[13px] ${sentDays >= 7 ? "text-ink underline underline-offset-2" : "text-ink-secondary"}`}>
                            {sentDays >= 7 ? "Follow-up due" : `Follow-up in ${7 - sentDays}d`}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-ink underline underline-offset-2 hover:text-ink-secondary"
                          >
                            <MessageSquare size={16} />
                            {row.linkedin_url ? "Profile" : "Find in Recruiter"}
                            <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {row.status === "pending" || row.status === "needs_review" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={isBusy}
                              disabled={!row.e1_body || !row.first_name}
                              onClick={() => void generate(row.who_id)}
                            >
                              {row.status === "needs_review" ? "Regenerate" : "Generate"}
                            </Button>
                          ) : null}
                          {row.initial_message ? (
                            <Button size="sm" variant="secondary" onClick={() => setOpenId(row.who_id)}>
                              Open
                            </Button>
                          ) : null}
                          {row.status === "generated" || row.status === "needs_review" ? (
                            <Button size="sm" variant="ghost" title="InMail sent and follow-up scheduled in Recruiter" onClick={() => void setStatus(row, "followup_sent")}>
                              Both sent
                            </Button>
                          ) : null}
                          {row.status === "sent" ? (
                            <Button size="sm" variant="ghost" onClick={() => void setStatus(row, "followup_sent")}>
                              Follow-up sent
                            </Button>
                          ) : null}
                          {row.status !== "dismissed" && row.status !== "followup_sent" ? (
                            <Button size="sm" variant="ghost" className="text-ink-muted" onClick={() => void setStatus(row, "dismissed")}>
                              Dismiss
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}

        {open ? (
          <div
            className="fixed inset-0 z-50 flex items-end bg-navy/50 sm:items-center sm:justify-center sm:p-6"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpenId(null);
            }}
          >
            <div
              className="flex h-[100dvh] w-full flex-col bg-white sm:h-auto sm:max-h-[95vh] sm:max-w-3xl sm:rounded-lg sm:border sm:border-line"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6 sm:py-4">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-medium text-ink">
                    {open.contact_name} · {open.account_name}
                  </h2>
                  <p className="mt-0.5 text-[13px] text-ink-secondary">
                    E5 sent {open.e5_sent_at ?? "—"}. Copy subject and both messages into Recruiter, schedule the follow-up there, then mark both sent.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {profileHref(open) ? (
                    <a
                      href={profileHref(open)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-line-strong bg-white px-3 text-sm font-medium text-ink hover:bg-surface-3"
                      title={open.linkedin_url ? "LinkedIn profile from Salesforce" : isMobile ? "Search in the LinkedIn app" : "Search in LinkedIn Recruiter"}
                    >
                      <MessageSquare size={16} /> {open.linkedin_url ? "Open profile" : isMobile ? "Find on LinkedIn" : "Open in Recruiter"}
                    </a>
                  ) : null}
                  {open.contact_name ? (
                    <a
                      href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
                        [open.contact_name, open.account_name].filter(Boolean).join(" "),
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hidden h-9 items-center rounded-sm px-2 text-[13px] text-ink-secondary hover:bg-surface-3 hover:text-ink sm:inline-flex"
                      title="Plain LinkedIn search, if Recruiter search misses"
                    >
                      LinkedIn search
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpenId(null)}
                    className="flex h-9 w-9 items-center justify-center rounded-sm text-xl text-ink-secondary hover:bg-surface-3 hover:text-ink"
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
                {open.flags.filter((f) => f.startsWith("Draft:")).length > 0 ? (
                  <Alert variant="warn">
                    <ul className="list-disc pl-4">
                      {open.flags
                        .filter((f) => f.startsWith("Draft:"))
                        .map((f) => (
                          <li key={f}>{f.replace(/^Draft:\s*/, "")}</li>
                        ))}
                    </ul>
                  </Alert>
                ) : null}

                <section>
                  <label className="mb-1.5 block text-[13px] text-ink-secondary">Subject</label>
                  <div className="flex gap-2">
                    <input
                      value={draftSubject}
                      onChange={(event) => setDraftSubject(event.target.value)}
                      className="h-10 flex-1 rounded-sm border border-line-strong px-3 text-base text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4 sm:text-[15px]"
                    />
                    <Button size="sm" variant="secondary" leftIcon={copied === "subject" ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copy("subject")}>
                      {copied === "subject" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </section>

                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-[13px] text-ink-secondary">Initial InMail</label>
                    <span className={`text-[13px] tabular-nums ${draftInitial.length > 1900 ? "text-danger" : "text-ink-muted"}`}>
                      {draftInitial.length} / 1900
                    </span>
                  </div>
                  <textarea
                    value={draftInitial}
                    onChange={(event) => setDraftInitial(event.target.value)}
                    className="min-h-56 w-full resize-y rounded-sm border border-line-strong p-3 text-base leading-7 text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4 sm:text-[15px] sm:leading-6"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" leftIcon={copied === "initial" ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copy("initial")}>
                      {copied === "initial" ? "Copied" : "Copy initial"}
                    </Button>
                  </div>
                </section>

                <section>
                  <label className="mb-1.5 block text-[13px] text-ink-secondary">
                    Follow-up InMail <span className="text-ink-muted">(paste into Recruiter's scheduled follow-up, about a week out)</span>
                  </label>
                  <textarea
                    value={draftFollowup}
                    onChange={(event) => setDraftFollowup(event.target.value)}
                    className="min-h-28 w-full resize-y rounded-sm border border-line-strong p-3 text-base leading-7 text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-surface-4 sm:text-[15px] sm:leading-6"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" leftIcon={copied === "followup" ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copy("followup")}>
                      {copied === "followup" ? "Copied" : "Copy follow-up"}
                    </Button>
                  </div>
                </section>

                <details className="rounded-md border border-line bg-white p-3 text-sm">
                  <summary className="cursor-pointer text-ink">Original E1 from Salesforce</summary>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-ink-secondary">{open.e1_body ?? "No E1 body stored."}</pre>
                </details>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-line bg-white p-3 sm:px-6 sm:py-4">
                <Button variant="ghost" onClick={() => void generate(open.who_id)} loading={busy.has(open.who_id)}>
                  Regenerate
                </Button>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" onClick={() => void saveDrafts()}>
                    Save edits
                  </Button>
                  {open.status !== "followup_sent" ? (
                    <>
                      {open.status !== "sent" ? (
                        <Button
                          variant="secondary"
                          title="Only the first InMail went out; follow-up to be sent by hand later"
                          onClick={() => void setStatus(open, "sent")}
                        >
                          Initial only
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        title="InMail sent and follow-up scheduled in Recruiter"
                        onClick={() => void setStatus(open, "followup_sent")}
                      >
                        Both sent
                      </Button>
                    </>
                  ) : (
                    <Button variant="secondary" onClick={() => setOpenId(null)}>
                      Close
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </>
  );
}
