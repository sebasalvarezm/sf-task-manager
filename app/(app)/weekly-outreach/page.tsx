"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, format, parse, startOfWeek } from "date-fns";
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
const GRID_COLUMN_COUNT = 11;

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

type WeeklyRowChanges = {
  status?: WeeklyOutreachStatus;
  notes?: string | null;
  outreachType?: WeeklyOutreachType;
  accountName?: string;
  website?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  tier?: string | null;
  groupName?: string | null;
};

type GridCellElement = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

function thisWeek(): string {
  return format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
}

function weekPickerValue(weekStart: string): string {
  return format(new Date(`${weekStart}T12:00:00`), "RRRR-'W'II");
}

function weekStartFromPicker(value: string): string {
  const parsed = parse(value, "RRRR-'W'II", new Date());
  return format(startOfWeek(parsed, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

function weekLabel(weekStart: string): string {
  const monday = new Date(`${weekStart}T12:00:00`);
  return `${format(monday, "MMM d")} – ${format(addDays(monday, 6), "MMM d, yyyy")}`;
}

function clipboardGrid(text: string): string[][] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
    .slice(0, 50);
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
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [items, setItems] = useState<WeeklyOutreachItem[]>([]);
  const [draftRows, setDraftRows] = useState<DraftSheetRow[]>(createDraftRows);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preparingRces, setPreparingRces] = useState<Set<string>>(new Set());
  const [reviewingRceId, setReviewingRceId] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [outlookReconnectRequired, setOutlookReconnectRequired] = useState(false);
  const loadingRef = useRef(false);
  const searchTimers = useRef<Map<string, number>>(new Map());
  const companyInputs = useRef<Map<string, HTMLInputElement>>(new Map());
  const gridCells = useRef<Map<string, GridCellElement>>(new Map());

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
  const totalGridRows = items.length + visibleDraftRows.length;
  const reviewingRce = reviewingRceId
    ? items.find((item) => item.id === reviewingRceId) ?? null
    : null;

  function registerGridCell(rowIndex: number, columnIndex: number) {
    return (element: GridCellElement | null) => {
      const key = `${rowIndex}:${columnIndex}`;
      if (element) gridCells.current.set(key, element);
      else gridCells.current.delete(key);
    };
  }

  function focusGridCell(rowIndex: number, columnIndex: number) {
    gridCells.current.get(`${rowIndex}:${columnIndex}`)?.focus();
  }

  function handleGridNavigation(
    event: React.KeyboardEvent<GridCellElement>,
    rowIndex: number,
    columnIndex: number,
  ): boolean {
    let nextRow = rowIndex;
    let nextColumn = columnIndex;
    const element = event.currentTarget;

    if (event.key === "Enter") {
      nextRow += event.shiftKey ? -1 : 1;
    } else if (event.key === "Tab") {
      nextColumn += event.shiftKey ? -1 : 1;
      if (nextColumn >= GRID_COLUMN_COUNT) {
        nextColumn = 0;
        nextRow += 1;
      } else if (nextColumn < 0) {
        nextColumn = GRID_COLUMN_COUNT - 1;
        nextRow -= 1;
      }
    } else if (event.key === "ArrowUp") {
      nextRow -= 1;
    } else if (event.key === "ArrowDown") {
      nextRow += 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (element instanceof HTMLInputElement && !element.readOnly) {
        const atLeftEdge = (element.selectionStart ?? 0) === 0;
        const atRightEdge = (element.selectionEnd ?? 0) === element.value.length;
        if (event.key === "ArrowLeft" && !atLeftEdge) return false;
        if (event.key === "ArrowRight" && !atRightEdge) return false;
      }
      nextColumn += event.key === "ArrowLeft" ? -1 : 1;
    } else {
      return false;
    }

    if (
      nextRow < 0 ||
      nextRow >= totalGridRows ||
      nextColumn < 0 ||
      nextColumn >= GRID_COLUMN_COUNT
    ) {
      return false;
    }
    event.preventDefault();
    focusGridCell(nextRow, nextColumn);
    return true;
  }

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

  async function handleSheetPaste(
    event: React.ClipboardEvent<HTMLElement>,
    gridRowIndex: number,
    gridColumnIndex: number,
  ) {
    const rows = clipboardGrid(event.clipboardData.getData("text/plain"));
    if (rows.length === 0) return;
    event.preventDefault();
    const startDraftIndex = Math.max(0, gridRowIndex - items.length);
    const maxColumns = Math.max(...rows.map((row) => row.length));
    const typeColumn = Array.from({ length: maxColumns }, (_, column) => column).find(
      (column) =>
        rows.every((row) => {
          const value = row[column]?.toUpperCase();
          return !value || value === "E1" || value === "RCE";
        }) && rows.some((row) => ["E1", "RCE"].includes(row[column]?.toUpperCase())),
    );

    if (rows.every((row) => row.length === 1) && gridColumnIndex === 0) {
      const types = rows.map((row) => row[0].toUpperCase());
      if (!types.every((type) => type === "E1" || type === "RCE")) {
        setError("The Type column accepts only E1 or RCE.");
        return;
      }
      setDraftRows((previous) =>
        previous.map((row, index) => {
          const pastedType = types[index - startDraftIndex];
          return pastedType
            ? { ...row, outreachType: pastedType as WeeklyOutreachType, error: null }
            : row;
        }),
      );
      setMessage(`${types.length} contact types pasted. Paste the company column beside them.`);
      return;
    }

    let entries: Array<{ outreachType: WeeklyOutreachType; accountName: string }> = [];
    if (typeColumn !== undefined && maxColumns > 1) {
      const companyColumn = Array.from({ length: maxColumns }, (_, column) => column).find(
        (column) =>
          column !== typeColumn &&
          column > typeColumn &&
          rows.some((row) => Boolean(row[column])),
      );
      if (companyColumn !== undefined) {
        entries = rows
          .map((row) => ({
            outreachType: row[typeColumn]?.toUpperCase() as WeeklyOutreachType,
            accountName: row[companyColumn] ?? "",
          }))
          .filter(
            (entry) =>
              ["E1", "RCE"].includes(entry.outreachType) && Boolean(entry.accountName),
          );
      }
    } else if (rows.every((row) => row.length === 1) && gridColumnIndex === 1) {
      const names = rows.map((row) => row[0]).filter(Boolean);
      setDraftRows((previous) =>
        previous.map((row, index) => {
          const accountName = names[index - startDraftIndex];
          return accountName ? { ...row, accountName, error: null } : row;
        }),
      );
      entries = names.flatMap((accountName, index) => {
        const outreachType = draftRows[startDraftIndex + index]?.outreachType;
        return outreachType ? [{ outreachType, accountName }] : [];
      });
      if (entries.length !== names.length) {
        setMessage(
          `${names.length} company names pasted. Add E1 or RCE in the missing Type cells to save them.`,
        );
        return;
      }
    } else if (rows.every((row) => row.length === 1)) {
      entries = rows.flatMap((row) => {
        const match = row[0].match(/^(E1|RCE)\s+(.+)$/i);
        return match
          ? [{ outreachType: match[1].toUpperCase() as WeeklyOutreachType, accountName: match[2].trim() }]
          : [];
      });
    }

    if (entries.length === 0) {
      setError("Paste Type and Company columns, for example E1 followed by the Salesforce company name.");
      return;
    }

    setPasting(true);
    setError(null);
    setMessage(null);
    setDraftRows((previous) =>
      previous.map((row, index) => {
        const entry = entries[index - startDraftIndex];
        return entry
          ? {
              ...row,
              outreachType: entry.outreachType,
              accountName: entry.accountName,
              results: [],
              saving: true,
              error: null,
            }
          : row;
      }),
    );
    try {
      const res = await fetch("/api/weekly-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, weekStart }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not paste companies");
      const results = (data.results ?? []) as Array<{
        index: number;
        item?: WeeklyOutreachItem;
        error?: string;
      }>;
      const savedItems = results.flatMap((result) => (result.item ? [result.item] : []));
      setItems((previous) => {
        const byId = new Map(previous.map((item) => [item.id, item]));
        for (const item of savedItems) byId.set(item.id, item);
        return sortItems([...byId.values()]);
      });
      setDraftRows((previous) =>
        previous.map((row, index) => {
          const result = results.find(
            (candidate) => candidate.index === index - startDraftIndex,
          );
          if (!result) return row;
          if (result.item) {
            return {
              ...row,
              outreachType: "",
              accountName: "",
              results: [],
              searching: false,
              saving: false,
              error: null,
            };
          }
          return { ...row, saving: false, error: result.error ?? "Could not save row" };
        }),
      );
      const failedCount = results.filter((result) => result.error).length;
      setMessage(
        `${savedItems.length} compan${savedItems.length === 1 ? "y" : "ies"} pasted and autofilled${
          failedCount ? `. ${failedCount} row${failedCount === 1 ? " needs" : "s need"} attention.` : "."
        }`,
      );
    } catch (pasteError) {
      setDraftRows((previous) =>
        previous.map((row, index) =>
          index >= startDraftIndex && index < startDraftIndex + entries.length
            ? { ...row, saving: false }
            : row,
        ),
      );
      setError(pasteError instanceof Error ? pasteError.message : "Could not paste companies");
    } finally {
      setPasting(false);
    }
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
    rowIndex: number,
  ) {
    if (event.key === "Escape") {
      patchDraftRow(row.key, { results: [], error: null });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      handleGridNavigation(event, rowIndex, 1);
      return;
    }
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
    changes: WeeklyRowChanges,
  ) {
    const optimisticChanges: Partial<WeeklyOutreachItem> = {};
    if (changes.status !== undefined) optimisticChanges.status = changes.status;
    if (changes.notes !== undefined) optimisticChanges.notes = changes.notes;
    if (changes.outreachType !== undefined) optimisticChanges.outreach_type = changes.outreachType;
    if (changes.accountName !== undefined) optimisticChanges.account_name = changes.accountName;
    if (changes.website !== undefined) optimisticChanges.website = changes.website;
    if (changes.industry !== undefined) optimisticChanges.industry = changes.industry;
    if (changes.country !== undefined) optimisticChanges.country = changes.country;
    if (changes.city !== undefined) optimisticChanges.city = changes.city;
    if (changes.tier !== undefined) optimisticChanges.tier = changes.tier;
    if (changes.groupName !== undefined) optimisticChanges.group_name = changes.groupName;
    setItems((previous) =>
      previous.map((row) => (row.id === item.id ? { ...row, ...optimisticChanges } : row)),
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
      router.push(`/sourcing?jobId=${data.jobId}`);
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

  async function prepareRce(item: WeeklyOutreachItem): Promise<boolean> {
    setPreparingRces((previous) => new Set(previous).add(item.id));
    setError(null);
    try {
      const res = await fetch("/api/weekly-outreach/prepare-rce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "OUTLOOK_RECONNECT_REQUIRED") {
          setOutlookReconnectRequired(true);
        }
        throw new Error(data.error ?? "Could not prepare reconnect");
      }
      setItems((previous) =>
        previous.map((row) => (row.id === item.id ? data.item : row)),
      );
      if (data.warning) setMessage(data.warning);
      return true;
    } catch (prepareError) {
      setError(
        prepareError instanceof Error ? prepareError.message : "Could not prepare reconnect",
      );
      return false;
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
    let preparedCount = 0;
    for (let index = 0; index < rces.length; index += 3) {
      const results = await Promise.all(rces.slice(index, index + 3).map(prepareRce));
      preparedCount += results.filter(Boolean).length;
    }
    if (preparedCount > 0) {
      setMessage(
        `Prepared ${preparedCount} Outlook reply draft${preparedCount === 1 ? "" : "s"}. Nothing was sent.`,
      );
    }
  }

  function openRceReview(item: WeeklyOutreachItem) {
    setReviewingRceId(item.id);
    setReviewDraft(item.draft ?? "");
    setError(null);
  }

  async function reviewRce(action: "save" | "send" | "dismiss") {
    if (!reviewingRce || reviewSaving) return;
    if (
      action === "send" &&
      !window.confirm(`Approve and send this reply to ${reviewingRce.account_name} through Outlook now?`)
    ) {
      return;
    }
    if (
      action === "dismiss" &&
      !window.confirm("Dismiss this reconnect draft and remove the matching Outlook draft?")
    ) {
      return;
    }
    setReviewSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/weekly-outreach/review-rce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: reviewingRce.id,
          action,
          draft: reviewDraft,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "OUTLOOK_RECONNECT_REQUIRED") {
          setOutlookReconnectRequired(true);
        }
        throw new Error(data.error ?? "Could not review reconnect");
      }
      setItems((previous) =>
        previous.map((item) => (item.id === reviewingRce.id ? data.item : item)),
      );
      if (action === "save") {
        setMessage("Draft saved in Weekly Outreach and Outlook.");
      } else {
        setReviewingRceId(null);
        setReviewDraft("");
        setMessage(
          action === "send"
            ? `Reconnect reply sent through Outlook to ${reviewingRce.account_name}.`
            : `Reconnect draft for ${reviewingRce.account_name} dismissed.`,
        );
      }
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Could not review reconnect");
    } finally {
      setReviewSaving(false);
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
            type="week"
            value={weekPickerValue(weekStart)}
            onChange={(event) => {
              if (event.target.value) setWeekStart(weekStartFromPicker(event.target.value));
            }}
            aria-label="Weekly Outreach week"
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
        {outlookReconnectRequired && (
          <Alert variant="info" onDismiss={() => setOutlookReconnectRequired(false)}>
            Outlook needs one permission refresh before it can create editable reply drafts.{" "}
            <a className="font-semibold underline" href="/api/microsoft/connect">
              Reconnect Outlook
            </a>
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
            <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap">
              <Button
                onClick={prepareAllRces}
                disabled={pasting || preparingRces.size > 0 || counts.rce === 0}
                className="w-full sm:w-auto"
              >
                Prepare RCE Drafts
              </Button>
              <Button className="w-full sm:w-auto" onClick={prepareE1s} disabled={pasting || saving || counts.e1 === 0}>
                Prepare E1 Sourcing Batch
              </Button>
              <Button className="w-full sm:w-auto" variant="secondary" onClick={copyCsv} disabled={items.length === 0}>
                Copy CSV
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-3 md:hidden">
          {visibleDraftRows[0] ? (
            <div className="rounded-xl border border-line bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Add to this week</h2>
                <span className="text-xs text-ink-muted">Salesforce autofill</span>
              </div>
              <div className="mb-3 grid grid-cols-2 gap-2">
                {(["E1", "RCE"] as WeeklyOutreachType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() =>
                      patchDraftRow(visibleDraftRows[0].key, {
                        outreachType: type,
                        error: null,
                      })
                    }
                    className={`h-11 rounded-lg border text-sm font-semibold ${
                      visibleDraftRows[0].outreachType === type
                        ? "border-brand bg-brand text-white"
                        : "border-line bg-white text-ink"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
              <div className="relative">
                <input
                  value={visibleDraftRows[0].accountName}
                  onPaste={(event) => void handleSheetPaste(event, items.length, 1)}
                  onChange={(event) =>
                    handleCompanyChange(visibleDraftRows[0], event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const exact = visibleDraftRows[0].results.find(
                        (result) =>
                          result.accountName.toLowerCase() ===
                          visibleDraftRows[0].accountName.trim().toLowerCase(),
                      );
                      void addAccountFromRow(
                        visibleDraftRows[0],
                        exact ??
                          (visibleDraftRows[0].results.length === 1
                            ? visibleDraftRows[0].results[0]
                            : undefined),
                      );
                    }
                  }}
                  disabled={visibleDraftRows[0].saving}
                  className="h-12 w-full rounded-lg border border-line bg-white px-3 text-base focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                  placeholder="Search Salesforce company"
                />
                {visibleDraftRows[0].searching || visibleDraftRows[0].saving ? (
                  <span className="absolute right-3 top-4 text-xs text-ink-muted">
                    {visibleDraftRows[0].saving ? "Saving…" : "Searching…"}
                  </span>
                ) : null}
                {visibleDraftRows[0].results.length > 0 ? (
                  <div className="absolute left-0 right-0 top-12 z-40 max-h-64 overflow-y-auto rounded-b-lg border border-line bg-white shadow-xl">
                    {visibleDraftRows[0].results.map((account) => (
                      <button
                        key={account.accountId}
                        type="button"
                        onClick={() => void addAccountFromRow(visibleDraftRows[0], account)}
                        className="block w-full border-b border-line px-3 py-3 text-left last:border-0"
                      >
                        <span className="block font-medium text-ink">{account.accountName}</span>
                        {account.website ? (
                          <span className="text-xs text-ink-muted">{account.website}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {visibleDraftRows[0].error ? (
                <p className="mt-2 text-xs text-danger">{visibleDraftRows[0].error}</p>
              ) : null}
            </div>
          ) : null}

          {items.map((item, index) => (
            <div key={item.id} className="rounded-xl border border-line bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-brand-soft px-2 py-1 text-xs font-bold text-brand">
                      {item.outreach_type}
                    </span>
                    <span className="text-xs text-ink-muted">#{index + 1}</span>
                  </div>
                  <h3 className="mt-2 truncate text-base font-semibold text-ink">
                    {item.account_name}
                  </h3>
                  <p className="mt-1 text-xs text-ink-muted">
                    {[item.industry, item.country, item.city].filter(Boolean).join(" · ") ||
                      "Salesforce details unavailable"}
                  </p>
                </div>
                <select
                  value={item.status}
                  onChange={(event) =>
                    updateRow(item, { status: event.target.value as WeeklyOutreachStatus })
                  }
                  className="h-9 rounded-md border border-line bg-white px-2 text-xs"
                >
                  {STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-surface-2 p-2">
                  <span className="block text-ink-muted">Tier</span>
                  <span className="font-medium text-ink">{item.tier || "—"}</span>
                </div>
                <div className="rounded-lg bg-surface-2 p-2">
                  <span className="block text-ink-muted">Group</span>
                  <span className="font-medium text-ink">{item.group_name || "—"}</span>
                </div>
              </div>

              <details className="mt-3 border-t border-line pt-3">
                <summary className="cursor-pointer text-sm font-medium text-brand">
                  Edit Salesforce fields
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {([
                    ["Industry", "industry", item.industry],
                    ["Country", "country", item.country],
                    ["City", "city", item.city],
                    ["Tier", "tier", item.tier],
                    ["Group", "groupName", item.group_name],
                  ] as const).map(([label, field, value]) => (
                    <label key={field} className={field === "industry" || field === "groupName" ? "col-span-2" : ""}>
                      <span className="mb-1 block text-[11px] font-medium text-ink-muted">{label}</span>
                      <input
                        defaultValue={value ?? ""}
                        onBlur={(event) => updateRow(item, { [field]: event.target.value || null })}
                        className="h-10 w-full rounded-md border border-line px-2 text-sm"
                      />
                    </label>
                  ))}
                </div>
              </details>

              <textarea
                defaultValue={item.notes ?? ""}
                onBlur={(event) => updateRow(item, { notes: event.target.value || null })}
                className="mt-3 min-h-20 w-full rounded-lg border border-line p-3 text-sm"
                placeholder="Trip, angle, reminder…"
              />

              <div className="mt-3 grid grid-cols-2 gap-2">
                {item.outreach_type === "RCE" ? (
                  item.draft ? (
                    <Button className="col-span-2 w-full" onClick={() => openRceReview(item)}>
                      Review reconnect
                    </Button>
                  ) : (
                    <Button
                      className="col-span-2 w-full"
                      loading={preparingRces.has(item.id)}
                      onClick={() => void prepareRce(item)}
                    >
                      Prepare reconnect
                    </Button>
                  )
                ) : item.sourcing_job_id ? (
                  <Link
                    className="col-span-2 flex h-10 items-center justify-center rounded-md bg-brand font-medium text-white"
                    href={`/sourcing?jobId=${item.sourcing_job_id}`}
                  >
                    Open in Sourcing
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeRow(item)}
                  className="col-span-2 py-2 text-sm font-medium text-danger"
                >
                  Remove from week
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="hidden border border-line bg-white shadow-sm md:block">
          <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-2">
            <div>
              <span className="text-sm font-semibold text-ink">Week of {weekLabel(weekStart)}</span>
              <span className="ml-2 text-xs text-ink-muted">
                Paste Excel Type + Company columns into the first empty row.
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <span className={`h-2 w-2 rounded-full ${refreshing ? "bg-warning" : "bg-ok"}`} />
              {loading
                ? "Loading…"
                : pasting
                  ? "Matching pasted companies…"
                  : refreshing
                    ? "Updating…"
                    : "Live · auto-saved"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1500px] border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-surface-3 text-left font-semibold text-ink-muted">
                <tr>
                  <th className="w-10 border-b border-r border-line px-2 py-2 text-center">#</th>
                  <th className="w-20 border-b border-r border-line px-2 py-2">Type</th>
                  <th className="min-w-60 border-b border-r border-line px-2 py-2">Company</th>
                  <th className="min-w-40 border-b border-r border-line px-2 py-2">Industry</th>
                  <th className="min-w-32 border-b border-r border-line px-2 py-2">Country</th>
                  <th className="min-w-28 border-b border-r border-line px-2 py-2">City</th>
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
                    <td className="border-b border-r border-line p-0">
                      <select
                        ref={registerGridCell(index, 0)}
                        value={item.outreach_type}
                        onKeyDown={(event) => handleGridNavigation(event, index, 0)}
                        onChange={(event) =>
                          updateRow(item, { outreachType: event.target.value as WeeklyOutreachType })
                        }
                        className="h-10 w-full border-0 bg-transparent px-2 font-semibold text-brand focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand"
                      >
                        <option value="E1">E1</option>
                        <option value="RCE">RCE</option>
                      </select>
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input
                        ref={registerGridCell(index, 1)}
                        defaultValue={item.account_name}
                        onKeyDown={(event) => handleGridNavigation(event, index, 1)}
                        onBlur={(event) => {
                          if (event.target.value.trim() !== item.account_name) {
                            void updateRow(item, { accountName: event.target.value });
                          }
                        }}
                        className="h-10 w-full border-0 bg-transparent px-2 font-medium text-ink focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand"
                      />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 2)} defaultValue={item.industry ?? ""} onKeyDown={(event) => handleGridNavigation(event, index, 2)} onBlur={(event) => void updateRow(item, { industry: event.target.value || null })} className="h-10 w-full border-0 bg-transparent px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 3)} defaultValue={item.country ?? ""} onKeyDown={(event) => handleGridNavigation(event, index, 3)} onBlur={(event) => void updateRow(item, { country: event.target.value || null })} className="h-10 w-full border-0 bg-transparent px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 4)} defaultValue={item.city ?? ""} onKeyDown={(event) => handleGridNavigation(event, index, 4)} onBlur={(event) => void updateRow(item, { city: event.target.value || null })} className="h-10 w-full border-0 bg-transparent px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 5)} defaultValue={item.tier ?? ""} onKeyDown={(event) => handleGridNavigation(event, index, 5)} onBlur={(event) => void updateRow(item, { tier: event.target.value || null })} className="h-10 w-full border-0 bg-transparent px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 6)} defaultValue={item.group_name ?? ""} onKeyDown={(event) => handleGridNavigation(event, index, 6)} onBlur={(event) => void updateRow(item, { groupName: event.target.value || null })} className="h-10 w-full border-0 bg-transparent px-2 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(index, 7)} readOnly value={item.source} onKeyDown={(event) => handleGridNavigation(event, index, 7)} className="h-10 w-full border-0 bg-surface-2 px-2 capitalize text-ink-muted focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line px-1">
                      <select
                        ref={registerGridCell(index, 8)}
                        value={item.status}
                        onKeyDown={(event) => handleGridNavigation(event, index, 8)}
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
                    <td className="border-b border-r border-line p-0">
                      {item.outreach_type === "RCE" && !item.draft ? (
                        <button
                          ref={registerGridCell(index, 9)}
                          type="button"
                          onKeyDown={(event) => handleGridNavigation(event, index, 9)}
                          onClick={() => void prepareRce(item)}
                          disabled={preparingRces.has(item.id)}
                          className="h-10 w-full px-2 text-left font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
                        >
                          {preparingRces.has(item.id) ? "Preparing…" : "Prepare"}
                        </button>
                      ) : item.outreach_type === "RCE" && item.draft ? (
                        <button
                          ref={registerGridCell(index, 9)}
                          type="button"
                          onKeyDown={(event) => handleGridNavigation(event, index, 9)}
                          onClick={() => openRceReview(item)}
                          className="h-10 w-full px-2 text-left font-medium text-brand hover:bg-brand-soft"
                        >
                          Review
                        </button>
                      ) : (
                        <button ref={registerGridCell(index, 9)} type="button" onKeyDown={(event) => handleGridNavigation(event, index, 9)} className="h-10 w-full px-2 text-left text-ink-muted">
                          {item.outreach_type === "E1" ? (item.sourcing_job_id ? "In Sourcing" : "—") : "—"}
                        </button>
                      )}
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input
                        ref={registerGridCell(index, 10)}
                        defaultValue={item.notes ?? ""}
                        onKeyDown={(event) => handleGridNavigation(event, index, 10)}
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
                        ref={registerGridCell(items.length + draftIndex, 0)}
                        value={row.outreachType}
                        onPaste={(event) =>
                          void handleSheetPaste(
                            event,
                            items.length + draftIndex,
                            0,
                          )
                        }
                        onKeyDown={(event) =>
                          handleGridNavigation(event, items.length + draftIndex, 0)
                        }
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
                          const gridKey = `${items.length + draftIndex}:1`;
                          if (element) {
                            companyInputs.current.set(row.key, element);
                            gridCells.current.set(gridKey, element);
                          } else {
                            companyInputs.current.delete(row.key);
                            gridCells.current.delete(gridKey);
                          }
                        }}
                        value={row.accountName}
                        onPaste={(event) =>
                          void handleSheetPaste(
                            event,
                            items.length + draftIndex,
                            1,
                          )
                        }
                        onChange={(event) => handleCompanyChange(row, event.target.value)}
                        onKeyDown={(event) =>
                          handleCompanyKeyDown(event, row, items.length + draftIndex)
                        }
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
                    {Array.from({ length: 5 }, (_, emptyIndex) => (
                      <td key={emptyIndex} className="border-b border-r border-line p-0">
                        <input
                          ref={registerGridCell(items.length + draftIndex, emptyIndex + 2)}
                          readOnly
                          onKeyDown={(event) =>
                            handleGridNavigation(
                              event,
                              items.length + draftIndex,
                              emptyIndex + 2,
                            )
                          }
                          className="h-10 w-full border-0 bg-transparent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand"
                        />
                      </td>
                    ))}
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(items.length + draftIndex, 7)} readOnly value="Manual" onKeyDown={(event) => handleGridNavigation(event, items.length + draftIndex, 7)} className="h-10 w-full border-0 bg-surface-2 px-2 text-ink-muted focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(items.length + draftIndex, 8)} readOnly value="Queued" onKeyDown={(event) => handleGridNavigation(event, items.length + draftIndex, 8)} className="h-10 w-full border-0 bg-transparent px-2 text-ink-muted focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <button ref={registerGridCell(items.length + draftIndex, 9)} type="button" onKeyDown={(event) => handleGridNavigation(event, items.length + draftIndex, 9)} className="h-10 w-full focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" aria-label="Empty draft cell" />
                    </td>
                    <td className="border-b border-r border-line p-0">
                      <input ref={registerGridCell(items.length + draftIndex, 10)} readOnly onKeyDown={(event) => handleGridNavigation(event, items.length + draftIndex, 10)} className="h-10 w-full border-0 bg-transparent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand" />
                    </td>
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

        {reviewingRce ? (
          <div className="fixed inset-0 z-50 flex items-end bg-navy/50 sm:items-center sm:justify-center sm:p-6">
            <div className="flex max-h-[95vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-w-3xl sm:rounded-2xl">
              <div className="flex items-start justify-between border-b border-line px-4 py-4 sm:px-6">
                <div className="min-w-0">
                  <span className="text-xs font-bold uppercase tracking-wide text-brand">RCE review</span>
                  <h2 className="mt-1 truncate text-xl font-semibold text-ink">
                    {reviewingRce.account_name}
                  </h2>
                  <p className="mt-1 truncate text-sm text-ink-muted">
                    {reviewingRce.outlook_reply_subject || "Outlook reply draft"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewingRceId(null)}
                  className="ml-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xl text-ink-muted"
                  aria-label="Close reconnect review"
                >
                  ×
                </button>
              </div>

              <div className="overflow-y-auto px-4 py-4 sm:px-6">
                <section className="rounded-xl border border-info/20 bg-info-soft p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-ink">Where the conversation left off</h3>
                    <span className="shrink-0 text-[11px] text-ink-muted">Under 30 seconds</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-ink">
                    {reviewingRce.context_summary || "No relationship summary was available."}
                  </p>
                </section>

                <section className="mt-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <label htmlFor="rce-review-draft" className="text-sm font-semibold text-ink">
                      Reconnect email
                    </label>
                    <span className={`text-xs ${reviewingRce.outlook_draft_ready ? "text-ok" : "text-warning"}`}>
                      {reviewingRce.outlook_draft_ready
                        ? "Connected to an Outlook reply draft"
                        : "No Outlook reply thread attached"}
                    </span>
                  </div>
                  <textarea
                    id="rce-review-draft"
                    value={reviewDraft}
                    onChange={(event) => setReviewDraft(event.target.value)}
                    className="min-h-64 w-full resize-y rounded-xl border border-line p-4 text-[15px] leading-6 text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                  />
                  <p className="mt-2 text-xs text-ink-muted">
                    Save keeps Outlook synchronized. Approve and Send sends this exact text as a reply in the existing chain.
                  </p>
                </section>
              </div>

              <div className="grid grid-cols-2 gap-2 border-t border-line bg-surface-2 p-4 sm:flex sm:justify-between sm:px-6">
                <Button
                  variant="ghost"
                  className="order-3 col-span-2 text-danger sm:order-none sm:col-span-1"
                  disabled={reviewSaving}
                  onClick={() => void reviewRce("dismiss")}
                >
                  Dismiss draft
                </Button>
                <div className="contents sm:flex sm:gap-2">
                  <Button
                    variant="secondary"
                    className="w-full"
                    loading={reviewSaving}
                    disabled={!reviewingRce.outlook_draft_ready || !reviewDraft.trim()}
                    onClick={() => void reviewRce("save")}
                  >
                    Save to Outlook
                  </Button>
                  <Button
                    className="w-full"
                    loading={reviewSaving}
                    disabled={!reviewingRce.outlook_draft_ready || !reviewDraft.trim()}
                    onClick={() => void reviewRce("send")}
                  >
                    Approve &amp; Send
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </PageContent>
    </>
  );
}
