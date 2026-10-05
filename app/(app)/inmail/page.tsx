"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Sparkles, Copy, Check, MessageSquare } from "lucide-react";
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

  const profileHref = (row: Row) => row.linkedin_url ?? row.navigator_url ?? null;

  return (
    <>
      <PageHeader
        title="InMail Queue"
        subtitle="Contacts who finished the email sequence without replying. InMails are built from the E1 that was actually sent."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              E5 in last
              <select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink"
              >
                {[7, 14, 30, 60].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <Button variant="secondary" loading={refreshing} onClick={() => void refresh()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh from Salesforce
            </Button>
            <Button
              loading={generatingAll}
              disabled={!items.some((r) => r.status === "pending" && r.e1_body && r.first_name)}
              onClick={() => void generateAll()}
            >
              <Sparkles className="mr-1.5 h-4 w-4" /> Generate all pending
            </Button>
          </div>
        }
      />
      <PageContent>
        {error ? (
          <Alert variant="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {message ? (
          <Alert variant="ok" onDismiss={() => setMessage(null)}>
            {message}
          </Alert>
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
              className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                filter === key ? "border-brand bg-brand text-white" : "border-line bg-white text-ink hover:bg-surface-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line bg-white p-10 text-center text-sm text-ink-muted">
            {items.length === 0
              ? "Nothing queued yet. Click Refresh from Salesforce to pull contacts whose E5 went out recently with no reply."
              : "Nothing in this view."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-white">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-surface-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">E5 sent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">LinkedIn</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const since = daysSince(row.e5_sent_at ? `${row.e5_sent_at}T12:00:00` : null);
                  const sentDays = daysSince(row.sent_at);
                  const href = profileHref(row);
                  const isBusy = busy.has(row.who_id);
                  return (
                    <tr key={row.who_id} className="border-t border-line align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{row.contact_name ?? "Unknown contact"}</div>
                        {row.contact_email ? <div className="text-xs text-ink-muted">{row.contact_email}</div> : null}
                        {row.flags.length > 0 ? (
                          <ul className="mt-1 space-y-0.5 text-xs text-warning">
                            {row.flags.map((flag) => (
                              <li key={flag}>{flag}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink">{row.account_name ?? "—"}</td>
                      <td className="px-4 py-3 text-ink-muted">
                        {row.e5_sent_at ?? "—"}
                        {since !== null ? <div className="text-xs">{since}d ago</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_LABEL[row.status].variant} dot>
                          {STATUS_LABEL[row.status].label}
                        </Badge>
                        {row.status === "sent" && sentDays !== null ? (
                          <div className={`mt-1 text-xs ${sentDays >= 7 ? "font-semibold text-brand" : "text-ink-muted"}`}>
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
                            className="inline-flex items-center gap-1 text-brand hover:underline"
                          >
                            <MessageSquare className="h-4 w-4" />
                            {row.linkedin_url ? "Profile" : "Find in Recruiter"}
                            <ExternalLink className="h-3 w-3" />
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
                            <Button size="sm" onClick={() => setOpenId(row.who_id)}>
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
              className="flex h-[100dvh] w-full flex-col bg-white shadow-2xl sm:h-auto sm:max-h-[95vh] sm:max-w-3xl sm:rounded-2xl"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6 sm:py-4">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-ink">
                    {open.contact_name} · {open.account_name}
                  </h2>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    E5 sent {open.e5_sent_at ?? "—"}. Copy subject and both messages into Recruiter, schedule the follow-up there, then mark both sent.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {profileHref(open) ? (
                    <a
                      href={profileHref(open)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center gap-1 rounded-lg border border-line px-3 text-sm font-medium text-ink hover:bg-surface-2"
                      title={open.linkedin_url ? "LinkedIn profile from Salesforce" : "Search in LinkedIn Recruiter"}
                    >
                      <MessageSquare className="h-4 w-4" /> {open.linkedin_url ? "Open profile" : "Open in Recruiter"}
                    </a>
                  ) : null}
                  {open.contact_name ? (
                    <a
                      href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
                        [open.contact_name, open.account_name].filter(Boolean).join(" "),
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hidden h-9 items-center rounded-lg px-2 text-xs text-ink-muted hover:underline sm:inline-flex"
                      title="Plain LinkedIn search, if Recruiter search misses"
                    >
                      LinkedIn search
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpenId(null)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-3 text-xl text-ink-muted"
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
                  <label className="mb-1.5 block text-sm font-semibold text-ink">Subject</label>
                  <div className="flex gap-2">
                    <input
                      value={draftSubject}
                      onChange={(event) => setDraftSubject(event.target.value)}
                      className="h-10 flex-1 rounded-xl border border-line px-3 text-base text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 sm:text-[15px]"
                    />
                    <Button size="sm" variant="secondary" onClick={() => void copy("subject")}>
                      {copied === "subject" ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                      {copied === "subject" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </section>

                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-sm font-semibold text-ink">Initial InMail</label>
                    <span className={`text-xs ${draftInitial.length > 1900 ? "text-danger" : "text-ink-muted"}`}>
                      {draftInitial.length} / 1900
                    </span>
                  </div>
                  <textarea
                    value={draftInitial}
                    onChange={(event) => setDraftInitial(event.target.value)}
                    className="min-h-56 w-full resize-y rounded-xl border border-line p-4 text-base leading-7 text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 sm:text-[15px] sm:leading-6"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => void copy("initial")}>
                      {copied === "initial" ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                      {copied === "initial" ? "Copied" : "Copy initial"}
                    </Button>
                  </div>
                </section>

                <section>
                  <label className="mb-1.5 block text-sm font-semibold text-ink">
                    Follow-up InMail <span className="font-normal text-ink-muted">(paste into Recruiter's scheduled follow-up, about a week out)</span>
                  </label>
                  <textarea
                    value={draftFollowup}
                    onChange={(event) => setDraftFollowup(event.target.value)}
                    className="min-h-28 w-full resize-y rounded-xl border border-line p-4 text-base leading-7 text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 sm:text-[15px] sm:leading-6"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void copy("followup")}>
                      {copied === "followup" ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                      {copied === "followup" ? "Copied" : "Copy follow-up"}
                    </Button>
                  </div>
                </section>

                <details className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-ink">Original E1 from Salesforce</summary>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-ink-muted">{open.e1_body ?? "No E1 body stored."}</pre>
                </details>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 p-3 sm:px-6 sm:py-4">
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
