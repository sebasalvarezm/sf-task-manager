"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { format, startOfWeek } from "date-fns";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Alert } from "@/app/components/ui/Alert";
import type {
  WeeklyOutreachItem,
  WeeklyOutreachStatus,
  WeeklyOutreachType,
} from "@/lib/weekly-outreach";

const WEEKLY_GOAL = 30;
const MINIMUM_SHEET_ROWS = 35;
const LIVE_REFRESH_MS = 5_000;

const STATUSES: Array<{ value: WeeklyOutreachStatus; label: string }> = [
  { value: "queued", label: "Queued" },
  { value: "needs_context", label: "Needs context" },
  { value: "researching", label: "Researching" },
  { value: "draft_ready", label: "Draft ready" },
  { value: "approved", label: "Approved" },
  { value: "sent", label: "Sent" },
];

type AccountSearchResult = {
  accountId: string;
  accountName: string;
  accountUrl: string;
  website: string | null;
};

type DraftSheetRow = {
  key: string;
  outreachType: "" | WeeklyOutreachType;
  accountName: string;
  results: AccountSearchResult[];
  searching: boolean;
  saving: boolean;
  error: string | null;
};

function thisWeek(): string {
  return format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
}

function createDraftRows(): DraftSheetRow[] {
  return Array.from({ length: MINIMUM_SHEET_ROWS }, (_, index) => ({
    key: `draft-${index}`,
    outreachType: "",
    accountName: "",
    results: [],
    searching: false,
    saving: false,
    error: null,
  }));
}

function csvCell(value: unknown): string {
  const valueText = value == null ? "" : String(value);
  return `"${valueText.replace(/"/g, '""')}"`;
}

function sortItems(items: WeeklyOutreachItem[]): WeeklyOutreachItem[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export default function WeeklyOutreachPage() {
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [items, setItems] = useState<WeeklyOutreachItem[]>([]);
  const [draftRows, setDraftRows] = useState<DraftSheetRow[]>(createDraftRows);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preparingRces, setPreparingRces] = useState<Set<string>>(new Set());
  const loadingRef = useRef(false);
  const searchTimers = useRef<Map<string, number>>(new Map());
  const companyInputs = useRef<Map<string, HTMLInputElement>>(new Map());

  const load = useCallback(
    async (silent = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/weekly-outreach?weekStart=${weekStart}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load the week");
        setItems(sortItems(data.items ?? []));
        if (!silent) setError(null);
      } catch (loadError) {
        if (!silent) {
          setError(
            loadError instanceof Error ? loadError.message : "Could not load the week",
          );
        }
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [weekStart],
  );

  useEffect(() => {
    setItems([]);
    setDraftRows(createDraftRows());
    setError(null);
    setMessage(null);
    void load(false);

    const interval = window.setInterval(() => void load(true), LIVE_REFRESH_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [load]);

  useEffect(
    () => () => {
      for (const timer of searchTimers.current.values()) window.clearTimeout(timer);
    },
    [],
  );

  const counts = useMemo(
    () => ({
      total: items.length,
      e1: items.filter((item) => item.outreach_type === "E1").length,
      rce: items.filter((item) => item.outreach_type === "RCE").length,
      ready: items.filter((item) => item.status === "draft_ready").length,
    }),
    [items],
  );

  const blankRowCount = Math.max(5, MINIMUM_SHEET_ROWS - items.length);
  const visibleDraftRows = draftRows.slice(0, blankRowCount);
  const goalPercent = Math.min(100, (counts.total / WEEKLY_GOAL) * 100);

  function patchDraftRow(key: string, changes: Partial<DraftSheetRow>) {
    setDraftRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    );
  }

  function resetDraftRow(key: string) {
    patchDraftRow(key, {
      outreachType: "",
      accountName: "",
      results: [],
      searching: false,
      saving: false,
      error: null,
    });
  }

  function handleCompanyChange(row: DraftSheetRow, accountName: string) {
    const previousTimer = searchTimers.current.get(row.key);
    if (previousTimer) window.clearTimeout(previousTimer);
    patchDraftRow(row.key, {
      accountName,
      results: [],
      searching: accountName.trim().length >= 2,
      error: null,
    });
    if (accountName.trim().length < 2) return;

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/salesforce/search-accounts?q=${encodeURIComponent(accountName.trim())}`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Salesforce search failed");
        patchDraftRow(row.key, {
          results: data.accounts ?? [],
          searching: false,
        });
      } catch (searchError) {
        patchDraftRow(row.key, {
          results: [],
          searching: false,
          error:
            searchError instanceof Error ? searchError.message : "Salesforce search failed",
        });
      }
    }, 300);
    searchTimers.current.set(row.key, timer);
  }

  async function addAccountFromRow(
    row: DraftSheetRow,
    selectedAccount?: AccountSearchResult,
  ) {
    if (row.saving) return;
    if (!row.outreachType) {
      patchDraftRow(row.key, { error: "Choose E1 or RCE first." });
      return;
    }
    const accountName = selectedAccount?.accountName ?? row.accountName.trim();
    if (!accountName) {
      patchDraftRow(row.key, { error: "Enter a Salesforce company name." });
      return;
    }

    patchDraftRow(row.key, {
      accountName,
      results: [],
      searching: false,
      saving: true,
      error: null,
    });
    setError(null);
    setMessage(null);
    try {
      const body = selectedAccount
        ? {
            accountId: selectedAccount.accountId,
            outreachType: row.outreachType,
            weekStart,
            source: "manual",
          }
        : { entry: `${row.outreachType} ${accountName}`, weekStart };
      const res = await fetch("/api/weekly-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const matches = Array.isArray(data.candidates)
          ? ` Choose one of: ${data.candidates.join(", ")}`
          : "";
        throw new Error(`${data.error ?? "Could not add company"}${matches}`);
      }
      setItems((previous) => {
        const withoutDuplicate = previous.filter((item) => item.id !== data.item.id);
        return sortItems([...withoutDuplicate, data.item]);
      });
      resetDraftRow(row.key);
      setMessage(`${data.item.account_name} added as ${data.item.outreach_type}.`);
      window.setTimeout(() => companyInputs.current.get(row.key)?.focus(), 0);
    } catch (addError) {
      patchDraftRow(row.key, {
        saving: false,
        error: addError instanceof Error ? addError.message : "Could not add company",
      });
    }
  }

  function handleCompanyKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    row: DraftSheetRow,
  ) {
    if (event.key === "Escape") {
      patchDraftRow(row.key, { results: [], error: null });
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exact = row.results.find(
      (result) =>
        result.accountName.trim().toLowerCase() === row.accountName.trim().toLowerCase(),
    );
    const onlyResult = row.results.length === 1 ? row.results[0] : undefined;
    void addAccountFromRow(row, exact ?? onlyResult);
  }

  async function updateRow(
    item: WeeklyOutreachItem,
    changes: { status?: WeeklyOutreachStatus; notes?: string | null },
  ) {
    setItems((previous) =>
      previous.map((row) => (row.id === item.id ? { ...row, ...changes } : row)),
    );
    const res = await fetch("/api/weekly-outreach", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, ...changes }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not update row");
      await load(true);
    }
  }

  async function removeRow(item: WeeklyOutreachItem) {
    if (!window.confirm(`Remove ${item.account_name} from this week?`)) return;
    const res = await fetch(`/api/weekly-outreach?id=${item.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not remove row");
      return;
    }
    setItems((previous) => previous.filter((row) => row.id !== item.id));
  }

  async function prepareE1s() {
    const e1s = items.filter(
      (item) =>
        item.outreach_type === "E1" && item.status !== "sent" && !item.sourcing_job_id,
    );
    if (e1s.length === 0) {
      setMessage("There are no unsourced E1s in this week.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "sourcing_bulk",
          input: {
            entries: e1s.map((item) => item.website || item.account_name),
            weeklyOutreachIds: e1s.map((item) => item.id),
          },
          label: `Weekly Outreach: ${e1s.length} E1${e1s.length === 1 ? "" : "s"}`,
          resultRoute: "/sourcing?jobId={jobId}",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create sourcing batch");
      await fetch("/api/weekly-outreach", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: e1s.map((item) => item.id),
          status: "researching",
          sourcingJobId: data.jobId,
        }),
      });
      setMessage(`Created one Sourcing batch for ${e1s.length} E1s. Nothing was sent.`);
      await load(true);
    } catch (prepareError) {
      setError(
        prepareError instanceof Error
          ? prepareError.message
          : "Could not create sourcing batch",
      );
    } finally {
      setSaving(false);
    }
  }

  async function prepareRce(item: WeeklyOutreachItem) {
    setPreparingRces((previous) => new Set(previous).add(item.id));
    setError(null);
    try {
      const res = await fetch("/api/weekly-outreach/prepare-rce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not prepare reconnect");
      setItems((previous) =>
        previous.map((row) => (row.id === item.id ? data.item : row)),
      );
    } catch (prepareError) {
      setError(
        prepareError instanceof Error ? prepareError.message : "Could not prepare reconnect",
      );
    } finally {
      setPreparingRces((previous) => {
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
    }
  }

  async function prepareAllRces() {
    const rces = items.filter(
      (item) => item.outreach_type === "RCE" && item.status !== "sent" && !item.draft,
    );
    for (let index = 0; index < rces.length; index += 3) {
      await Promise.all(rces.slice(index, index + 3).map(prepareRce));
    }
    if (rces.length > 0) {
      setMessage(
        `Prepared ${rces.length} reconnect draft${rces.length === 1 ? "" : "s"}. Nothing was sent.`,
      );
    }
  }

  async function copyCsv() {
    const headers = [
      "Week",
      "Type",
      "Company",
      "Industry",
      "Country",
      "City",
      "Tier",
      "Group",
      "Source",
      "RCE Days",
      "Status",
      "Notes",
    ];
    const rows = items.map((item) => [
      item.week_start,
      item.outreach_type,
      item.account_name,
      item.industry,
      item.country,
      item.city,
      item.tier,
      item.group_name,
      item.source,
      item.rce_days,
      item.status,
      item.notes,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");
    await navigator.clipboard.writeText(csv);
    setMessage("Weekly Outreach copied as CSV.");
  }

  return (
    <>
      <PageHeader
        title="Weekly Outreach"
        subtitle={`${counts.total} / ${WEEKLY_GOAL} weekly goal · ${counts.rce} RCE · ${counts.e1} E1 · ${counts.ready} drafts ready`}
        actions={
          <input
            type="date"
            value={weekStart}
            onChange={(event) => setWeekStart(event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          />
        }
      />
      <PageContent>
        {error && (
          <Alert variant="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {message && (
          <Alert variant="ok" onDismiss={() => setMessage(null)}>
            {message}
          </Alert>
        )}

        <div className="mb-4 rounded-xl border border-line bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-ink">{counts.total}</span>
                <span className="text-sm font-semibold text-ink-muted">/ {WEEKLY_GOAL}</span>
                <span className="text-sm text-ink-muted">
                  {counts.total >= WEEKLY_GOAL
                    ? `${counts.total - WEEKLY_GOAL} above goal`
                    : `${WEEKLY_GOAL - counts.total} remaining`}
                </span>
              </div>
              <div className="mt-2 h-2 max-w-xl overflow-hidden rounded-full bg-surface-3">
                <div
                  className={`h-full rounded-full transition-all ${
                    counts.total >= WEEKLY_GOAL ? "bg-ok" : "bg-brand"
                  }`}
                  style={{ width: `${goalPercent}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={prepareAllRces}
                disabled={preparingRces.size > 0 || counts.rce === 0}
              >
                Prepare RCE Drafts
              </Button>
              <Button onClick={prepareE1s} disabled={saving || counts.e1 === 0}>
                Prepare E1 Sourcing Batch
              </Button>
              <Button variant="secondary" onClick={copyCsv} disabled={items.length === 0}>
                Copy CSV
              </Button>
            </div>
          </div>
        </div>

        <div className="border border-line bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-2">
            <div>
              <span className="text-sm font-semibold text-ink">Week of {weekStart}</span>
              <span className="ml-2 text-xs text-ink-muted">
                Type and company are editable. Salesforce fills the remaining columns.
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <span className={`h-2 w-2 rounded-full ${refreshing ? "bg-warning" : "bg-ok"}`} />
              {loading ? "Loading…" : refreshing ? "Updating…" : "Live · auto-saved"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1280px] border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-surface-3 text-left font-semibold text-ink-muted">
                <tr>
                  <th className="w-10 border-b border-r border-line px-2 py-2 text-center">#</th>
                  <th className="w-20 border-b border-r border-line px-2 py-2">Type</th>
                  <th className="min-w-60 border-b border-r border-line px-2 py-2">Company</th>
                  <th className="min-w-40 border-b border-r border-line px-2 py-2">Industry</th>
                  <th className="min-w-36 border-b border-r border-line px-2 py-2">Country / City</th>
                  <th className="w-24 border-b border-r border-line px-2 py-2">Tier</th>
                  <th className="min-w-40 border-b border-r border-line px-2 py-2">Group</th>
                  <th className="w-24 border-b border-r border-line px-2 py-2">Source</th>
                  <th className="w-32 border-b border-r border-line px-2 py-2">Status</th>
                  <th className="w-32 border-b border-r border-line px-2 py-2">Draft</th>
                  <th className="min-w-52 border-b border-r border-line px-2 py-2">Trip / Notes</th>
                  <th className="w-12 border-b border-line px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.id} className="h-10 hover:bg-brand-soft/30">
                    <td className="border-b border-r border-line bg-surface-2 px-2 text-center text-ink-muted">
                      {index + 1}
                    </td>
                    <td className="border-b border-r border-line px-2 font-semibold text-brand">
                      {item.outreach_type}
                      {item.rce_days ? <span className="ml-1 text-[10px] text-ink-muted">{item.rce_days}d</span> : null}
                    </td>
                    <td className="border-b border-r border-line px-2 font-medium text-ink">
                      {item.account_url ? (
                        <a
                          className="hover:text-brand hover:underline"
                          href={item.account_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.account_name}
                        </a>
                      ) : (
                        item.account_name
                      )}
                    </td>
                    <td className="border-b border-r border-line px-2">{item.industry || ""}</td>
                    <td className="border-b border-r border-line px-2">
                      {[item.country, item.city].filter(Boolean).join(" · ")}
                    </td>
                    <td className="border-b border-r border-line px-2">{item.tier || ""}</td>
                    <td className="border-b border-r border-line px-2">{item.group_name || ""}</td>
                    <td className="border-b border-r border-line px-2 capitalize text-ink-muted">
                      {item.source}
                    </td>
                    <td className="border-b border-r border-line px-1">
                      <select
                        value={item.status}
                        onChange={(event) =>
                          updateRow(item, {
                            status: event.target.value as WeeklyOutreachStatus,
                          })
                        }
                        className="h-8 w-full border-0 bg-transparent px-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
                      >
                        {STATUSES.map((status) => (
                          <option key={status.value} value={status.value}>
                            {status.label}
                          </option>
                        ))}
                      </select>
                      {item.sourcing_job_id ? (
                        <Link className="px-1 text-[10px] text-brand underline" href={`/sourcing?jobId=${item.sourcing_job_id}`}>
                          Open sourcing
                        </Link>
                      ) : null}
                    </td>
                    <td className="border-b border-r border-line px-2">
                      {item.outreach_type === "RCE" && !item.draft ? (
                        <button
                          type="button"
                          onClick={() => prepareRce(item)}
                          disabled={preparingRces.has(item.id)}
                          className="font-medium text-brand hover:underline disabled:opacity-50"
                        >
                          {preparingRces.has(item.id) ? "Preparing…" : "Prepare"}
                        </button>
                      ) : null}
                      {item.draft ? (
                        <details className="relative">
                          <summary className="cursor-pointer font-medium text-brand">View draft</summary>
                          <div className="absolute right-0 z-30 mt-2 w-96 rounded-lg border border-line bg-white p-3 shadow-xl">
                            {item.context_summary ? (
                              <p className="mb-2 text-ink-muted">{item.context_summary}</p>
                            ) : null}
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-ink">
                              {item.draft}
                            </pre>
                            <button
                              type="button"
                              onClick={() => navigator.clipboard.writeText(item.draft ?? "")}
                              className="mt-2 font-medium text-brand underline"
                            >
                              Copy draft
                            </button>
                          </div>
                        </details>
                      ) : null}
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input
                        defaultValue={item.notes ?? ""}
                        onBlur={(event) =>
                          updateRow(item, { notes: event.target.value || null })
                        }
                        className="h-10 w-full border-0 bg-transparent px-2 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand"
                        placeholder="Trip, angle, reminder…"
                      />
                    </td>
                    <td className="border-b border-line px-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeRow(item)}
                        className="text-base text-ink-muted hover:text-danger"
                        aria-label={`Remove ${item.account_name}`}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}

                {visibleDraftRows.map((row, draftIndex) => (
                  <tr key={row.key} className="h-10 bg-white">
                    <td className="border-b border-r border-line bg-surface-2 px-2 text-center text-ink-muted">
                      {items.length + draftIndex + 1}
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <select
                        value={row.outreachType}
                        onChange={(event) => {
                          patchDraftRow(row.key, {
                            outreachType: event.target.value as "" | WeeklyOutreachType,
                            error: null,
                          });
                          window.setTimeout(
                            () => companyInputs.current.get(row.key)?.focus(),
                            0,
                          );
                        }}
                        disabled={row.saving}
                        className="h-10 w-full border-0 bg-transparent px-2 text-xs font-semibold text-brand focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand"
                      >
                        <option value="">—</option>
                        <option value="E1">E1</option>
                        <option value="RCE">RCE</option>
                      </select>
                    </td>
                    <td className="relative border-b border-r border-line p-0">
                      <input
                        ref={(element) => {
                          if (element) companyInputs.current.set(row.key, element);
                          else companyInputs.current.delete(row.key);
                        }}
                        value={row.accountName}
                        onChange={(event) => handleCompanyChange(row, event.target.value)}
                        onKeyDown={(event) => handleCompanyKeyDown(event, row)}
                        disabled={row.saving}
                        className={`h-10 w-full border-0 bg-transparent px-2 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-inset ${
                          row.error ? "focus:ring-danger" : "focus:ring-brand"
                        }`}
                        placeholder={draftIndex === 0 ? "Search Salesforce company…" : ""}
                      />
                      {row.searching || row.saving ? (
                        <span className="absolute right-2 top-3 text-[10px] text-ink-muted">
                          {row.saving ? "Saving…" : "Searching…"}
                        </span>
                      ) : null}
                      {row.results.length > 0 ? (
                        <div className="absolute left-0 right-0 top-10 z-40 max-h-52 overflow-y-auto border border-line bg-white shadow-xl">
                          {row.results.map((account) => (
                            <button
                              key={account.accountId}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void addAccountFromRow(row, account)}
                              className="block w-full border-b border-line px-3 py-2 text-left hover:bg-brand-soft"
                            >
                              <span className="font-medium text-ink">{account.accountName}</span>
                              {account.website ? (
                                <span className="ml-2 text-[10px] text-ink-muted">{account.website}</span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {row.error ? (
                        <div className="absolute left-0 top-10 z-30 min-w-full whitespace-nowrap border border-danger/30 bg-danger-soft px-2 py-1 text-[10px] text-danger shadow">
                          {row.error}
                        </div>
                      ) : null}
                    </td>
                    {Array.from({ length: 4 }, (_, index) => (
                      <td key={index} className="border-b border-r border-line" />
                    ))}
                    <td className="border-b border-r border-line px-2 text-ink-muted">Manual</td>
                    <td className="border-b border-r border-line px-2 text-ink-muted">Queued</td>
                    <td className="border-b border-r border-line" />
                    <td className="border-b border-r border-line" />
                    <td className="border-b border-line" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-3 text-xs text-ink-muted">
          Entries from Open Tasks and Re-Contact are added to the bottom automatically. The sheet keeps five empty rows after the weekly target and continues expanding beyond 30.
        </p>
      </PageContent>
    </>
  );
}
