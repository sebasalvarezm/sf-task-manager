"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Inbox as InboxIcon, ChevronDown, ChevronUp } from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";
import { Badge } from "@/app/components/ui/Badge";

type Sentiment = "positive" | "neutral" | "negative" | "unclear";
type Status = "new" | "drafted" | "sent" | "skipped";

type ThreadMessage = { from: string; email: string; at: string; mine: boolean; text: string };

type Row = {
  message_id: string;
  conversation_id: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  from_domain: string | null;
  received_at: string;
  preview: string | null;
  thread: ThreadMessage[];
  has_mine: boolean;
  account_id: string | null;
  account_name: string | null;
  account_matched_by: "domain" | "subject" | null;
  sentiment: Sentiment | null;
  timing_text: string | null;
  suggested_date: string | null;
  summary: string | null;
  is_broker_intro: boolean;
  status: Status;
  draft_body: string | null;
  sent_at: string | null;
};

type Filter = "todo" | "done" | "all";

const SENTIMENT: Record<Sentiment, { label: string; variant: "ok" | "warn" | "danger" | "neutral" }> = {
  positive: { label: "Positive", variant: "ok" },
  neutral: { label: "Neutral", variant: "warn" },
  negative: { label: "Negative", variant: "danger" },
  unclear: { label: "Unclear", variant: "neutral" },
};

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

function longDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}

export default function InboxPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todo");
  const [openId, setOpenId] = useState<string | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState<string>("");
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the inbox");
      setItems(data.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the inbox");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 14 }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error("The refresh took too long. Try again in a moment.");
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      setItems(data.items ?? []);
      const s = data.summary;
      setMessage(
        `${s.scanned} unread in the last 14 days: ${s.added} new ${s.added === 1 ? "reply" : "replies"} added` +
          (s.alreadyKnown ? `, ${s.alreadyKnown} already here` : "") +
          (s.skippedAutomated ? `, ${s.skippedAutomated} automated` : "") +
          (s.skippedInternal ? `, ${s.skippedInternal} internal` : "") +
          ".",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  const open = openId ? items.find((r) => r.message_id === openId) ?? null : null;
  useEffect(() => {
    setThreadOpen(false);
    setSheetError(null);
    setDateDraft(open?.suggested_date ?? "");
  }, [open?.message_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // On phones the sheet is exactly the visible viewport (keyboard excluded).
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVisibleHeight(Math.round(vv.height));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setVisibleHeight(null);
    };
  }, [open]);
  const sheetStyle: React.CSSProperties | undefined =
    visibleHeight && typeof window !== "undefined" && window.innerWidth < 640
      ? { height: visibleHeight, maxHeight: visibleHeight }
      : undefined;

  const visible = useMemo(
    () =>
      items.filter((r) => {
        if (filter === "all") return true;
        if (filter === "todo") return r.status === "new" || r.status === "drafted";
        return r.status === "sent" || r.status === "skipped";
      }),
    [items, filter],
  );
  const counts = useMemo(
    () => ({
      todo: items.filter((r) => r.status === "new" || r.status === "drafted").length,
      done: items.filter((r) => r.status === "sent" || r.status === "skipped").length,
    }),
    [items],
  );

  function replaceRow(row: Row) {
    setItems((prev) => prev.map((r) => (r.message_id === row.message_id ? row : r)));
  }

  async function patch(body: Record<string, unknown>): Promise<Row | null> {
    if (!open) return null;
    setBusy(true);
    setSheetError(null);
    try {
      const res = await fetch("/api/inbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: open.message_id, ...body }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error("No answer from the server. Try again.");
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      replaceRow(data.item);
      return data.item as Row;
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function setSentiment(sentiment: Sentiment) {
    await patch({ sentiment });
  }
  async function skip() {
    const row = await patch({ status: "skipped" });
    if (row) setOpenId(null);
  }
  async function reclassify() {
    const row = await patch({ reclassify: true });
    if (row) setDateDraft(row.suggested_date ?? "");
  }
  async function saveDate() {
    await patch({ suggestedDate: dateDraft || null });
  }

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Replies to your outreach, classified. Tap one to see the thread and the proposed next touch."
        actions={
          <Button variant="secondary" leftIcon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />} loading={refreshing} onClick={() => void refresh()}>
            Check Outlook
          </Button>
        }
      />
      <PageContent>
        {error ? <Alert variant="danger" className="mb-4">{error}</Alert> : null}
        {message ? <Alert variant="info" className="mb-4">{message}</Alert> : null}

        <div className="mb-4 flex gap-2 overflow-x-auto">
          {(
            [
              ["todo", `To answer (${counts.todo})`],
              ["done", `Done (${counts.done})`],
              ["all", "All"],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${
                filter === key ? "border-navy bg-navy text-white" : "border-line bg-white text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            <InboxIcon className="mx-auto mb-2" size={20} />
            {items.length === 0 ? "Nothing here yet. Tap Check Outlook to pull unread replies." : "Nothing in this view."}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((r) => {
              const s = r.sentiment ? SENTIMENT[r.sentiment] : null;
              return (
                <button
                  key={r.message_id}
                  type="button"
                  onClick={() => setOpenId(r.message_id)}
                  className="w-full rounded-xl border border-line bg-white p-3 text-left shadow-sm active:bg-surface-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold text-ink">
                          {r.account_name ?? r.from_name ?? r.from_email}
                        </span>
                        {s ? <Badge variant={s.variant} size="sm">{s.label}</Badge> : <Badge variant="neutral" size="sm">Not classified</Badge>}
                        {!r.account_id ? <Badge variant="neutral" size="sm">{r.is_broker_intro ? "Broker" : "No account"}</Badge> : null}
                        {r.status === "skipped" ? <Badge variant="neutral" size="sm">Skipped</Badge> : null}
                        {r.status === "sent" ? <Badge variant="ok" size="sm">Replied</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {r.from_name ?? r.from_email}
                        {r.account_name && r.from_name ? ` · ${r.subject ?? ""}` : r.subject ? ` · ${r.subject}` : ""}
                      </p>
                      <p className="mt-1.5 line-clamp-2 text-sm text-ink-secondary">{r.summary ?? r.preview}</p>
                      {r.suggested_date ? (
                        <p className="mt-1 text-xs text-ink-muted">Next touch: {longDate(r.suggested_date)}{r.timing_text ? ` (“${r.timing_text}”)` : ""}</p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-xs text-ink-muted">{daysAgo(r.received_at)}</span>
                  </div>
                </button>
              );
            })}
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
              className="flex h-[100dvh] w-full flex-col bg-white shadow-2xl sm:h-auto sm:max-h-[95vh] sm:max-w-2xl sm:rounded-2xl"
              style={sheetStyle}
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between border-b border-line px-4 py-3 sm:px-6">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-ink">{open.account_name ?? open.from_name ?? open.from_email}</h2>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {open.from_name} &lt;{open.from_email}&gt; · {longDate(open.received_at)}
                    {open.account_id ? ` · matched by ${open.account_matched_by}` : " · no Salesforce account"}
                  </p>
                </div>
                <button type="button" onClick={() => setOpenId(null)} className="ml-4 rounded-lg px-2 py-1 text-sm text-ink-muted hover:bg-surface-2">
                  Close
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-6">
                {sheetError ? <Alert variant="danger" className="mb-3">{sheetError}</Alert> : null}

                <div className="rounded-xl border border-line bg-surface-3 p-3">
                  <p className="whitespace-pre-wrap text-sm text-ink">{open.thread[open.thread.length - 1]?.text || open.preview}</p>
                  {open.thread.length > 1 ? (
                    <button type="button" onClick={() => setThreadOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-xs font-medium text-brand">
                      {threadOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {threadOpen ? "Hide earlier messages" : `Show ${open.thread.length - 1} earlier message${open.thread.length - 1 === 1 ? "" : "s"}`}
                    </button>
                  ) : null}
                  {threadOpen
                    ? open.thread.slice(0, -1).reverse().map((m, i) => (
                        <div key={i} className="mt-3 border-t border-line pt-2">
                          <p className="text-xs font-medium text-ink-muted">
                            {m.mine ? "You" : m.from || m.email} · {longDate(m.at)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{m.text}</p>
                        </div>
                      ))
                    : null}
                </div>

                <div className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Read as</p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {(["positive", "neutral", "negative", "unclear"] as Sentiment[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={busy}
                        onClick={() => void setSentiment(s)}
                        className={`rounded-full border px-3 py-1.5 text-sm ${
                          open.sentiment === s ? "border-navy bg-navy text-white" : "border-line bg-white text-ink"
                        }`}
                      >
                        {SENTIMENT[s].label}
                      </button>
                    ))}
                  </div>
                  {open.summary ? <p className="mt-2 text-sm text-ink-secondary">{open.summary}</p> : null}
                  {open.is_broker_intro ? <p className="mt-1 text-xs text-ink-muted">Looks like a broker intro: no Salesforce changes will be made for it.</p> : null}
                </div>

                <div className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Next touch (RCE task)</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      type="date"
                      value={dateDraft}
                      onChange={(e) => setDateDraft(e.target.value)}
                      onBlur={() => { if (dateDraft !== (open.suggested_date ?? "")) void saveDate(); }}
                      className="h-11 flex-1 rounded-lg border border-line px-3 text-base"
                    />
                    {dateDraft ? (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDateDraft(""); void patch({ suggestedDate: null }); }}>
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {open.timing_text ? `They said “${open.timing_text}”.` : open.sentiment === "positive" ? "Positive replies get no task; the call is the next step." : "No timing in their reply; default used."}
                    {" "}Nothing is written to Salesforce yet; replies and task updates come in the next step.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-line bg-surface-2 p-3 sm:px-6">
                <Button variant="ghost" disabled={busy} onClick={() => void reclassify()}>Reclassify</Button>
                <div className="flex-1" />
                <Button variant="secondary" disabled={busy} onClick={() => void skip()}>Skip</Button>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </>
  );
}
