"use client";

/**
 * Inbox (Nov 2026 redesign): one pile of replies to answer, Mail-style.
 * - The reply type (Book a call / Accept their time / Acknowledge / Check back
 *   later) decides the draft, the scheduling-bot CC and the RCE, not the
 *   sentiment. Sentiment only feeds Salesforce's response type.
 * - Dismiss from the list (swipe on a phone), with Undo.
 * - Out-of-office replies sit in their own folded group; "left the company"
 *   stays in the pile with the new contact shown.
 * Nothing is sent or written to Salesforce without a tap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, MoreHorizontal, PenLine, X, Plane, UserX } from "lucide-react";
import { Alert } from "@/app/components/ui/Alert";
import { PageContent } from "@/app/components/ui/PageContent";
import { REPLY_TYPES, REPLY_TYPE_LABEL, replyDefaults, type ReplyType } from "@/lib/inbox-classify";

type Sentiment = "positive" | "neutral" | "negative" | "unclear";
type Status = "new" | "drafted" | "sent" | "skipped";
type ThreadMessage = { from: string; email: string; at: string; mine: boolean; text: string };

type Row = {
  message_id: string;
  conversation_id: string;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  received_at: string;
  preview: string | null;
  thread: ThreadMessage[];
  account_id: string | null;
  account_name: string | null;
  account_matched_by: "contact" | "domain" | "subject" | null;
  sentiment: Sentiment | null;
  timing_text: string | null;
  suggested_date: string | null;
  summary: string | null;
  is_broker_intro: boolean;
  status: Status;
  draft_body: string | null;
  sent_at: string | null;
  task_id: string | null;
  task_date: string | null;
  reply_type: ReplyType;
  auto_reply: "out_of_office" | "left_company" | null;
  return_date: string | null;
  new_contact: string | null;
};

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, sans-serif';

const TYPE_HINT: Record<ReplyType, string> = {
  book_call: "Your scheduling sentence. The scheduling tool sends times and the Teams invite.",
  accept_time: "Confirms the time they named. No scheduling tool.",
  acknowledge: "A short thank-you. No call ask, no RCE.",
  check_back: "Closes the loop and sets the RCE on their timing.",
  none: "Automatic reply. Nothing to answer.",
};

const SENTIMENT_LABEL: Record<Sentiment, string> = { positive: "Positive", neutral: "Neutral", negative: "Negative", unclear: "Unclear" };

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-CA", { weekday: "long" });
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}
function longDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
}
function parseRce(input: string): number | null | undefined {
  const t = input.trim().toLowerCase();
  if (!t || t === "none" || t === "0" || t === "-") return null;
  const m = t.match(/^(?:rce\s*)?(\d{1,4})$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 && n <= 1500 ? n : undefined;
}
function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);
const isOpen = (r: Row) => r.status === "new" || r.status === "drafted";

export default function InboxPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [awayOpen, setAwayOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; undoId?: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Sheet state
  const [openId, setOpenId] = useState<string | null>(null);
  const [threadOpen, setThreadOpen] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [replyType, setReplyType] = useState<ReplyType>("acknowledge");
  const [cc, setCc] = useState(false);
  const [rceInput, setRceInput] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftIssues, setDraftIssues] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const sendRef = useRef<() => void>(() => {});
  const draftSeq = useRef(0);
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);

  // Signature
  const [sigOpen, setSigOpen] = useState(false);
  const [sig, setSig] = useState<{ text: string; source: string } | null | undefined>(undefined);
  const [sigText, setSigText] = useState("");
  const [sigBusy, setSigBusy] = useState(false);
  const [sigError, setSigError] = useState<string | null>(null);

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
    void fetch("/api/inbox/signature", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSig(d.signature ? { text: d.signature.text, source: d.signature.source } : null))
      .catch(() => setSig(null));
    // Opening the page also syncs with Outlook, unless it just did (3 minutes).
    let stale = true;
    try {
      stale = Date.now() - Number(localStorage.getItem("inbox:last-refresh") ?? 0) > 3 * 60_000;
    } catch {
      /* no storage: just refresh */
    }
    if (stale) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: 14 }) });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error("The refresh took too long. Try again in a moment.");
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      setItems(data.items ?? []);
      try {
        localStorage.setItem("inbox:last-refresh", String(Date.now()));
      } catch {
        /* ignore */
      }
      const s = data.summary;
      setMessage(s.added ? `${s.added} new ${s.added === 1 ? "reply" : "replies"}.` : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function signatureAction(body: Record<string, unknown>) {
    setSigBusy(true);
    setSigError(null);
    try {
      const res = await fetch("/api/inbox/signature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error("No answer from the server.");
      if (!res.ok) throw new Error(data.error ?? "Could not save the signature");
      setSig(data.signature ? { text: data.signature.text, source: data.signature.source } : null);
      setSigText("");
    } catch (err) {
      setSigError(err instanceof Error ? err.message : "Could not save the signature");
    } finally {
      setSigBusy(false);
    }
  }

  function replaceRow(row: Row) {
    setItems((prev) => prev.map((r) => (r.message_id === row.message_id ? row : r)));
  }
  function showToast(text: string, undoId?: string) {
    setToast({ text, undoId });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }

  async function patchRow(messageId: string, body: Record<string, unknown>): Promise<{ item?: Row; [k: string]: unknown } | null> {
    const res = await fetch("/api/inbox", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, ...body }) });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("No answer from the server. Try again.");
    if (!res.ok) throw new Error(data.error ?? "Could not save");
    if (data.item) replaceRow(data.item);
    return data;
  }

  async function dismiss(row: Row) {
    // Out of the list at once; the server call follows.
    setItems((prev) => prev.map((r) => (r.message_id === row.message_id ? { ...r, status: "skipped" } : r)));
    if (openId === row.message_id) setOpenId(null);
    try {
      const data = await patchRow(row.message_id, { dismiss: true });
      showToast(`${row.account_name ?? row.from_name ?? "Reply"} dismissed${data?.outlook === false ? " (could not mark it read in Outlook)" : ""}.`, row.message_id);
    } catch (err) {
      replaceRow(row);
      setError(err instanceof Error ? err.message : "Could not dismiss");
    }
  }
  async function undo(messageId: string) {
    setToast(null);
    try {
      await patchRow(messageId, { undismiss: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo");
    }
  }
  async function oooReminder(row: Row) {
    setItems((prev) => prev.map((r) => (r.message_id === row.message_id ? { ...r, status: "skipped" } : r)));
    try {
      const data = (await patchRow(row.message_id, { oooReminder: true })) as { task?: { action: string; date: string } };
      showToast(`${row.account_name}: RCE task ${data?.task?.action ?? "set"} for ${longDate(data?.task?.date ?? null)}.`);
    } catch (err) {
      replaceRow(row);
      setError(err instanceof Error ? err.message : "Could not set the reminder");
    }
  }

  const pile = useMemo(() => items.filter((r) => isOpen(r) && r.auto_reply !== "out_of_office"), [items]);
  const away = useMemo(() => items.filter((r) => isOpen(r) && r.auto_reply === "out_of_office"), [items]);
  const open = openId ? items.find((r) => r.message_id === openId) ?? null : null;

  // ── Sheet ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setThreadOpen(false);
    setSheetError(null);
    setMenuOpen(false);
    setDraftIssues([]);
    setArmed(false);
    if (!open) return;
    const type = open.reply_type;
    const d = replyDefaults(type, open, today());
    setReplyType(type);
    setCc(d.cc);
    setRceInput(d.rceDays ? String(d.rceDays) : "");
    setDraftBody(open.draft_body ?? "");
    if (!open.draft_body && type !== "none") void draft(open.message_id, type, d.rceDays);
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
    visibleHeight && typeof window !== "undefined" && window.innerWidth < 640 ? { height: visibleHeight, maxHeight: visibleHeight } : undefined;

  async function draft(messageId: string, type: ReplyType, rceDays: number | null | undefined, mode: "natural" | "template" = "natural") {
    const seq = ++draftSeq.current;
    setDrafting(true);
    setSheetError(null);
    try {
      const res = await fetch("/api/inbox/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, replyType: type, mode, nextTouchDate: typeof rceDays === "number" ? addDaysIso(rceDays) : null }),
      });
      const data = await res.json().catch(() => null);
      if (seq !== draftSeq.current) return; // a newer draft was asked for
      if (!data) throw new Error("The draft took too long. Tap Redraft.");
      if (!res.ok) throw new Error(data.error ?? "Could not draft the reply");
      replaceRow({ ...data.item });
      setDraftBody(data.draft.body ?? "");
      setDraftIssues(data.draft.issues ?? []);
    } catch (err) {
      if (seq === draftSeq.current) setSheetError(err instanceof Error ? err.message : "Could not draft the reply");
    } finally {
      if (seq === draftSeq.current) setDrafting(false);
    }
  }

  function pickType(type: ReplyType) {
    if (!open || type === replyType) return;
    const d = replyDefaults(type, open, today());
    setReplyType(type);
    setCc(d.cc);
    setRceInput(d.rceDays ? String(d.rceDays) : "");
    setArmed(false);
    void draft(open.message_id, type, d.rceDays);
  }

  async function sheetAction(body: Record<string, unknown>, close = true) {
    if (!open) return;
    setBusy(true);
    setSheetError(null);
    try {
      const data = await patchRow(open.message_id, body);
      if (data?.item && body.reclassify) {
        const row = data.item as Row;
        const d = replyDefaults(row.reply_type, row, today());
        setReplyType(row.reply_type);
        setCc(d.cc);
        setRceInput(d.rceDays ? String(d.rceDays) : "");
        if (row.reply_type !== "none") void draft(row.message_id, row.reply_type, d.rceDays);
      } else if (close) setOpenId(null);
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const rceDays = parseRce(rceInput);
  const rceDate = typeof rceDays === "number" ? addDaysIso(rceDays) : null;
  const hasAccount = Boolean(open?.account_id) && !open?.is_broker_intro;
  const canSend = Boolean(open) && replyType !== "none" && !sending && !drafting && draftBody.trim().length > 0 && rceDays !== undefined;

  useEffect(() => {
    sendRef.current = () => {
      if (canSend) void send();
    };
  });
  useEffect(() => {
    if (!openId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendRef.current();
      }
      if (event.key === "Escape") setOpenId(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

  async function send() {
    if (!open || sending) return;
    if (rceDays === undefined) {
      setSheetError("Next touch must be a number of days (like 50), or blank for none.");
      return;
    }
    // Tap twice: the first tap arms (button turns green), the second sends. Resets after 3s.
    if (!armed) {
      setArmed(true);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmed(false);
    setSending(true);
    setSheetError(null);
    try {
      const res = await fetch("/api/inbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: open.message_id, body: draftBody, rceDays, sentiment: open.sentiment ?? undefined, cc }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error("No answer from the server. Check Sent Items before trying again.");
      if (!res.ok) throw new Error(data.error ?? "Could not send");
      replaceRow(data.item);
      const to = (data.recipients ?? []).map((r: { name: string | null; email: string }) => r.name ?? r.email).join(", ");
      const sf = data.salesforce;
      const parts = [`Sent to ${to}${data.cc?.length ? ` (cc ${data.cc.join(", ")})` : ""}.`];
      if (sf?.task) parts.push(`RCE task ${sf.task.action} for ${longDate(sf.task.date)}.`);
      if (sf?.skipped && sf.skipped !== "no Salesforce account" && sf.skipped !== "broker intro") parts.push(`Salesforce: ${sf.skipped}.`);
      showToast(parts.join(" "));
      setOpenId(null);
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  const armedLabel = `Tap again to send${hasAccount ? ` + Salesforce${typeof rceDays === "number" ? `, RCE ${rceDays}d` : ""}` : ""}`;

  return (
    <div style={{ fontFamily: SYSTEM_FONT }}>
      <PageContent>
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-5 flex items-end justify-between gap-3">
            <div>
              <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-ink">Inbox</h1>
              <p className="mt-0.5 text-[15px] text-ink-muted">
                {loading ? "Loading…" : pile.length === 0 ? "All caught up" : `${pile.length} to answer`}
                {refreshing ? " · Checking Outlook…" : ""}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <IconButton label={sig ? "Signature (stored)" : "Signature"} onClick={() => setSigOpen((v) => !v)}>
                <PenLine size={18} />
              </IconButton>
              <IconButton label="Check Outlook" onClick={() => void refresh()} disabled={refreshing}>
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </IconButton>
            </div>
          </div>

          {error ? <Alert variant="danger" className="mb-4">{error}</Alert> : null}
          {message ? <p className="mb-3 text-[13px] text-ink-muted">{message}</p> : null}

          {sigOpen ? (
            <div className="mb-5 rounded-xl border border-line bg-white p-4">
              <p className="text-[15px] font-medium text-ink">Email signature</p>
              <p className="mt-1 text-[13px] text-ink-secondary">Added under your sign-off on every email this tool sends.</p>
              {sigError ? <Alert variant="danger" className="mt-3">{sigError}</Alert> : null}
              {sig ? (
                <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-3 p-3 font-sans text-[13px] text-ink-secondary">{sig.text}</pre>
              ) : (
                <p className="mt-3 text-[13px] text-ink-secondary">None stored.</p>
              )}
              <div className="mt-3 flex flex-wrap gap-4 text-[15px]">
                <button type="button" disabled={sigBusy} onClick={() => void signatureAction({ action: "import" })} className="text-info disabled:text-ink-muted">
                  {sig ? "Re-import from last sent email" : "Import from last sent email"}
                </button>
                {sig ? (
                  <button type="button" disabled={sigBusy} onClick={() => void signatureAction({ action: "clear" })} className="text-danger disabled:text-ink-muted">Remove</button>
                ) : null}
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-[13px] text-info">Or paste it as text</summary>
                <textarea value={sigText} onChange={(e) => setSigText(e.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-line bg-white p-3 text-base text-ink focus:border-info focus:outline-none" />
                <button type="button" disabled={sigBusy || !sigText.trim()} onClick={() => void signatureAction({ text: sigText })} className="mt-2 text-[15px] text-info disabled:text-ink-muted">Save pasted signature</button>
              </details>
            </div>
          ) : null}

          {!loading && pile.length === 0 ? (
            <div className="rounded-xl border border-line bg-white px-6 py-12 text-center">
              <p className="text-[17px] font-medium text-ink">No replies to answer</p>
              <p className="mt-1 text-[13px] text-ink-muted">New replies show up here when you open the page or tap refresh.</p>
            </div>
          ) : pile.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-line bg-white">
              {pile.map((r, i) => (
                <SwipeRow key={r.message_id} onDismiss={() => void dismiss(r)} last={i === pile.length - 1}>
                  <ReplyRow row={r} onOpen={() => setOpenId(r.message_id)} onDismiss={() => void dismiss(r)} />
                </SwipeRow>
              ))}
            </div>
          ) : null}

          {away.length > 0 ? (
            <div className="mt-6">
              <button type="button" onClick={() => setAwayOpen((v) => !v)} className="flex w-full items-center gap-2 px-1 py-2 text-left text-[13px] uppercase tracking-wide text-ink-muted">
                {awayOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Out of office ({away.length})
              </button>
              {awayOpen ? (
                <div className="overflow-hidden rounded-xl border border-line bg-white">
                  {away.map((r, i) => (
                    <SwipeRow key={r.message_id} onDismiss={() => void dismiss(r)} last={i === away.length - 1}>
                      <div className="flex items-center gap-3 px-4 py-3">
                        <Plane size={16} className="shrink-0 text-ink-muted" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] text-ink">{r.account_name ?? r.from_name ?? r.from_email}</p>
                          <p className="truncate text-[13px] text-ink-muted">
                            {r.from_name ?? r.from_email}
                            {r.return_date ? ` · back ${longDate(r.return_date)}` : " · no return date"}
                            {r.new_contact ? ` · meanwhile: ${r.new_contact}` : ""}
                          </p>
                        </div>
                        {r.return_date && r.account_id ? (
                          <button type="button" onClick={() => void oooReminder(r)} className="shrink-0 text-[13px] text-info" title="Moves or creates the account's open RCE task to the day after they are back, and files this reply">
                            RCE {longDate(addDayIso(r.return_date))}
                          </button>
                        ) : null}
                        <button type="button" onClick={() => void dismiss(r)} aria-label="Dismiss" className="shrink-0 rounded-full p-1.5 text-ink-muted hover:bg-surface-3 hover:text-ink">
                          <X size={16} />
                        </button>
                      </div>
                    </SwipeRow>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {toast ? (
          <div className="fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
            <div className="flex max-w-lg items-center gap-4 rounded-xl bg-ink px-4 py-3 text-[14px] text-white" style={{ boxShadow: "0 4px 16px rgba(0,0,0,.18)" }}>
              <span className="min-w-0 flex-1">{toast.text}</span>
              {toast.undoId ? (
                <button type="button" onClick={() => void undo(toast.undoId!)} className="shrink-0 font-medium text-[#8FB4FF]">Undo</button>
              ) : null}
            </div>
          </div>
        ) : null}

        {open ? (
          <div
            className="fixed inset-0 z-50 flex items-end bg-black/30 sm:items-center sm:justify-center sm:p-6"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpenId(null);
            }}
          >
            <div
              className="flex h-[100dvh] w-full flex-col bg-surface sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-xl"
              style={{ ...sheetStyle, fontFamily: SYSTEM_FONT }}
              role="dialog"
              aria-modal="true"
            >
              {/* Top bar */}
              <div className="relative flex items-center justify-between border-b border-line bg-white px-4 py-3 sm:rounded-t-xl">
                <button type="button" onClick={() => setOpenId(null)} className="text-[15px] text-info">Close</button>
                <p className="absolute left-1/2 max-w-[55%] -translate-x-1/2 truncate text-[15px] font-semibold text-ink">{open.account_name ?? open.from_name ?? open.from_email}</p>
                <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="More" className="rounded-full p-1 text-info hover:bg-surface-3">
                  <MoreHorizontal size={20} />
                </button>
                {menuOpen ? (
                  <div className="absolute right-3 top-full z-10 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-white shadow-xl">
                    <MenuItem onClick={() => { setMenuOpen(false); void dismiss(open); }}>Dismiss (no reply)</MenuItem>
                    <MenuItem onClick={() => { setMenuOpen(false); void sheetAction({ markUnread: true }); }}>Leave it for Outlook (mark unread)</MenuItem>
                    <MenuItem onClick={() => { setMenuOpen(false); void sheetAction({ reclassify: true }, false); }}>Read it again (reclassify)</MenuItem>
                  </div>
                ) : null}
              </div>

              <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3 sm:px-5">
                {sheetError ? <Alert variant="danger" className="mb-3">{sheetError}</Alert> : null}

                {/* Their message */}
                <div className="rounded-xl bg-white p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-[15px] font-semibold text-ink">{open.from_name ?? open.from_email}</p>
                    <p className="shrink-0 text-[13px] text-ink-muted">{when(open.received_at)}</p>
                  </div>
                  <p className="truncate text-[13px] text-ink-muted">{open.subject}</p>
                  {open.auto_reply ? <AutoReplyNote row={open} /> : null}
                  <p className={`mt-3 whitespace-pre-wrap text-[15px] leading-6 text-ink ${threadOpen ? "" : "line-clamp-6 sm:line-clamp-[10]"}`}>{open.thread[open.thread.length - 1]?.text || open.preview}</p>
                  {open.thread.length > 1 || (open.thread[open.thread.length - 1]?.text ?? "").length > 300 ? (
                    <button type="button" onClick={() => setThreadOpen((v) => !v)} className="mt-2 text-[13px] text-info">
                      {threadOpen ? "Show less" : open.thread.length > 1 ? `Show more and earlier messages (${open.thread.length - 1})` : "Show more"}
                    </button>
                  ) : null}
                  {threadOpen
                    ? open.thread.slice(0, -1).reverse().map((m, i) => (
                        <div key={i} className="mt-3 border-t border-line pt-3">
                          <p className="text-[13px] font-medium text-ink-secondary">{m.mine ? "You" : m.from || m.email} · {longDate(m.at)}</p>
                          <p className="mt-1 whitespace-pre-wrap text-[14px] leading-6 text-ink-secondary">{m.text}</p>
                        </div>
                      ))
                    : null}
                </div>

                {/* Reply type */}
                <p className="mb-1.5 mt-5 px-1 text-[13px] uppercase tracking-wide text-ink-muted">Reply</p>
                <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-surface-4 p-0.5 sm:grid-cols-4">
                  {REPLY_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      disabled={sending}
                      onClick={() => pickType(t)}
                      className={`rounded-md px-2 py-1.5 text-[13px] transition-colors ${replyType === t ? "bg-white font-medium text-ink" : "text-ink-secondary hover:text-ink"}`}
                    >
                      {REPLY_TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 px-1 text-[13px] text-ink-muted">{TYPE_HINT[replyType]}</p>

                {replyType !== "none" ? (
                  <>
                    <div className="mt-3 rounded-xl bg-white">
                      <textarea
                        value={drafting ? "" : draftBody}
                        onChange={(e) => setDraftBody(e.target.value)}
                        placeholder={drafting ? "Writing your reply…" : "Type your reply."}
                        disabled={drafting}
                        className="block min-h-48 w-full resize-y rounded-xl bg-transparent p-4 text-[15px] leading-6 text-ink placeholder:text-ink-muted focus:outline-none"
                      />
                      <div className="flex items-center justify-between border-t border-line px-4 py-2">
                        <span className="text-[13px] text-warn">{draftIssues.join(" ")}</span>
                        <div className="flex shrink-0 gap-4">
                          {replyType === "book_call" ? (
                            <button type="button" disabled={drafting || sending} onClick={() => void draft(open.message_id, replyType, rceDays, "template")} className="text-[13px] text-info disabled:text-ink-muted">
                              Standard
                            </button>
                          ) : null}
                          <button type="button" disabled={drafting || sending} onClick={() => void draft(open.message_id, replyType, rceDays)} className="text-[13px] text-info disabled:text-ink-muted">
                            {drafting ? "Writing…" : "Redraft"}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Settings group */}
                    <div className="mt-4 overflow-hidden rounded-xl bg-white">
                      <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-line px-4 py-3">
                        <span>
                          <span className="block text-[15px] text-ink">CC scheduling tool</span>
                          <span className="block text-[13px] text-ink-muted">bot@blockit.com sends times and the Teams invite</span>
                        </span>
                        <Toggle checked={cc} onChange={setCc} />
                      </label>
                      <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <span>
                          <span className="block text-[15px] text-ink">Next touch</span>
                          <span className="block text-[13px] text-ink-muted">
                            {!hasAccount
                              ? "No Salesforce account, nothing is written there"
                              : rceDays === undefined
                                ? "Days, like 50"
                                : rceDate
                                  ? `RCE task on ${longDate(rceDate)}${open.timing_text ? ` (they said “${open.timing_text}”)` : ""}`
                                  : "No RCE task"}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={rceInput}
                            onChange={(e) => setRceInput(e.target.value)}
                            disabled={!hasAccount}
                            placeholder="None"
                            className={`h-9 w-20 rounded-lg bg-surface-3 px-2 text-right text-[15px] text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-info/30 disabled:opacity-50 ${rceDays === undefined ? "ring-2 ring-danger/40" : ""}`}
                          />
                          <span className="text-[13px] text-ink-muted">days</span>
                        </span>
                      </div>
                    </div>
                    {hasAccount ? (
                      <p className="mt-1.5 px-1 text-[12px] text-ink-muted">
                        On send, {open.account_name} gets Responded{open.sentiment ? ` (${SENTIMENT_LABEL[open.sentiment]})` : ""} in Salesforce.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>

              {/* Bottom bar */}
              <div className="border-t border-line bg-white p-3 sm:rounded-b-xl sm:px-5">
                {replyType === "none" ? (
                  <button type="button" disabled={busy} onClick={() => void dismiss(open)} className="h-11 w-full rounded-lg bg-surface-4 text-[15px] font-medium text-ink hover:bg-line disabled:opacity-60">
                    Dismiss
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => void send()}
                    title="Ctrl+Enter also works: once to arm, again to send"
                    className={`h-11 w-full rounded-lg text-[15px] font-medium text-white transition-colors disabled:opacity-50 ${armed ? "bg-ok" : "bg-brand hover:bg-brand-hover"}`}
                  >
                    {sending ? "Sending…" : armed ? armedLabel : cc ? "Send, CC scheduling tool" : "Send"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </div>
  );
}

function addDayIso(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="flex h-9 w-9 items-center justify-center rounded-full text-info hover:bg-white disabled:text-ink-muted">
      {children}
    </button>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="block w-full border-b border-line px-4 py-3 text-left text-[15px] text-ink last:border-b-0 hover:bg-surface-3">
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.preventDefault();
        onChange(!checked);
      }}
      className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${checked ? "bg-ok" : "bg-line-strong"}`}
    >
      <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white transition-transform ${checked ? "translate-x-[22px]" : "translate-x-[2px]"}`} style={{ boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
    </button>
  );
}

function AutoReplyNote({ row }: { row: Row }) {
  if (row.auto_reply === "left_company") {
    return (
      <div className="mt-3 flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-ink">
        <UserX size={16} className="mt-0.5 shrink-0 text-warn" />
        <span>
          {row.from_name ?? "They"} has left the company.
          {row.new_contact ? <> Write to <span className="select-all font-medium">{row.new_contact}</span> instead.</> : " No new contact given."}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-3 flex gap-2 rounded-lg bg-surface-3 px-3 py-2 text-[13px] text-ink">
      <Plane size={16} className="mt-0.5 shrink-0 text-ink-muted" />
      <span>
        Out of office{row.return_date ? `, back ${longDate(row.return_date)}` : ""}.{row.new_contact ? ` Meanwhile: ${row.new_contact}.` : ""}
      </span>
    </div>
  );
}

function ReplyRow({ row, onOpen, onDismiss }: { row: Row; onOpen: () => void; onDismiss: () => void }) {
  const name = row.account_name ?? row.from_name ?? row.from_email ?? "Unknown";
  return (
    <div className="group relative flex items-start gap-3 bg-white px-4 py-3 hover:bg-surface-3">
      <span className={`mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full ${row.status === "new" ? "bg-info" : "bg-transparent"}`} aria-hidden />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
          <span className="flex shrink-0 items-center gap-1 text-[13px] text-ink-muted">
            {when(row.received_at)}
            <ChevronRight size={14} />
          </span>
        </div>
        <p className="truncate text-[14px] text-ink">
          {row.from_name && row.account_name ? `${row.from_name} · ` : ""}
          {row.subject ?? ""}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[14px] leading-5 text-ink-muted">{row.summary ?? row.preview}</p>
        <p className="mt-1 text-[12px]">
          {row.auto_reply === "left_company" ? (
            <span className="text-warn">Left the company{row.new_contact ? ` · write to ${row.new_contact}` : ""}</span>
          ) : (
            <span className="text-info">{REPLY_TYPE_LABEL[row.reply_type]}</span>
          )}
          {row.is_broker_intro ? <span className="text-ink-muted"> · Broker</span> : !row.account_id ? <span className="text-ink-muted"> · No Salesforce account</span> : null}
          {row.status === "drafted" ? <span className="text-ink-muted"> · Draft ready</span> : null}
        </p>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss: no reply, marked read in Outlook"
        className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-full border border-line bg-white px-3 py-1 text-[13px] text-ink-secondary hover:text-ink sm:group-hover:flex"
      >
        <X size={14} /> Dismiss
      </button>
    </div>
  );
}

/** Swipe left past the threshold to dismiss (phones). Vertical scrolling is left alone. */
function SwipeRow({ children, onDismiss, last }: { children: React.ReactNode; onDismiss: () => void; last: boolean }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const THRESHOLD = 96;
  return (
    <div className={`relative overflow-hidden ${last ? "" : "border-b border-line"}`}>
      {dx < 0 ? (
        <div className="absolute inset-y-0 right-0 flex items-center justify-end overflow-hidden bg-danger pr-5 text-[15px] font-medium text-white" style={{ width: -dx }}>
          {-dx > 60 ? "Dismiss" : null}
        </div>
      ) : null}
      <div
        style={{ transform: `translateX(${dx}px)`, transition: start.current ? "none" : "transform 180ms ease" }}
        onTouchStart={(e) => {
          start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, horizontal: null };
        }}
        onTouchMove={(e) => {
          const s = start.current;
          if (!s) return;
          const mx = e.touches[0].clientX - s.x;
          const my = e.touches[0].clientY - s.y;
          if (s.horizontal === null && (Math.abs(mx) > 10 || Math.abs(my) > 10)) s.horizontal = Math.abs(mx) > Math.abs(my);
          if (s.horizontal) setDx(Math.min(0, mx));
        }}
        onTouchEnd={() => {
          const go = dx < -THRESHOLD;
          start.current = null;
          setDx(go ? -600 : 0);
          if (go) {
            window.setTimeout(onDismiss, 150);
            // If the dismiss fails the row comes back; slide it back into view.
            window.setTimeout(() => setDx(0), 1200);
          }
        }}
        onClickCapture={(e) => {
          if (dx !== 0) e.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}
