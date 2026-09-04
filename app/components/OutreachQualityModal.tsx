"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { Modal } from "./ui/Modal";
import { Table } from "./ui/Table";
import { Button } from "./ui/Button";
import { Alert } from "./ui/Alert";
import { Spinner } from "./ui/Spinner";
import {
  QUALITY_FLAG_LABELS,
  parseYearInput,
  parseEmployeesInput,
  parseCountryInput,
  type QualityFlagKey,
  type QualityThresholds,
} from "@/lib/outreach-quality";

// The flagged ("BS") emails behind a chart click: who sent each one, which
// signals fired, and — where Salesforce is simply blank — an inline box to put
// the real value in and push it to the CRM. Filling a blank with a good value
// drops the row's flag count, and below the BS threshold it leaves the list.
//
// Deliberately NOT another dimension on DrillModal: that component is ~750
// lines, already forks on isOpps, and its rows are deduped by account with no
// sender, task or flag fields — and this table needs editable cells.

export type OutreachQualityTarget = {
  title: string;
  /** yyyy-MM-dd */
  start: string;
  /** yyyy-MM-dd */
  end: string;
  /** Full owner name, when drilling into one sender. */
  owner?: string;
};

type FlaggedRow = {
  taskId: string;
  activityDate: string;
  subjectType: string;
  owner: string;
  accountId: string;
  accountName: string;
  website: string | null;
  accountUrl: string;
  country: string | null;
  yearEstablished: string | null;
  numberOfEmployees: number | null;
  flags: QualityFlagKey[];
  missing: QualityFlagKey[];
};

type Props = {
  target: OutreachQualityTarget | null;
  team: string;
  onClose: () => void;
  /** Called after a successful write so the page's charts pick up the change. */
  onDataChanged?: () => void;
};

type Draft = { country: string; year: string; employees: string };
type SaveState = { status: "idle" | "saving" | "error"; message?: string };

const EMPTY_DRAFT: Draft = { country: "", year: "", employees: "" };

/** "https://www.mecka.com/" → "mecka.com", to fit the narrow company column. */
function prettyDomain(website: string): string {
  return website
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

export function OutreachQualityModal({
  target,
  team,
  onClose,
  onDataChanged,
}: Props) {
  const [rows, setRows] = useState<FlaggedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thresholds, setThresholds] = useState<QualityThresholds | null>(null);
  const [foundedAvailable, setFoundedAvailable] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<Record<string, SaveState>>({});

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!target) return;
      setError(null);
      const params = new URLSearchParams({
        start: target.start,
        end: target.end,
        team,
      });
      if (target.owner) params.set("owner", target.owner);
      try {
        const res = await fetch(
          `/api/salesforce/outreach-quality?${params.toString()}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (signal?.cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Failed to load flagged emails");
          setRows([]);
          return;
        }
        setRows((body.rows ?? []) as FlaggedRow[]);
        setThresholds(body.thresholds ?? null);
        setFoundedAvailable(body.foundedFieldAvailable !== false);
      } catch (err) {
        if (signal?.cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
        setRows([]);
      }
    },
    [target, team],
  );

  // Refetch whenever the target changes. `target` is a fresh object per click,
  // so identity comparison is the intended trigger.
  useEffect(() => {
    if (!target) return;
    const signal = { cancelled: false };
    setRows(null);
    setDrafts({});
    setSaving({});
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [target, load]);

  if (!target) return null;

  function draftFor(taskId: string): Draft {
    return drafts[taskId] ?? EMPTY_DRAFT;
  }

  function setDraft(taskId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [taskId]: { ...(prev[taskId] ?? EMPTY_DRAFT), ...patch },
    }));
  }

  /** Validates client-side first, so junk never reaches Salesforce. */
  function validate(row: FlaggedRow): { payload: Record<string, string>; error?: string } {
    const draft = draftFor(row.taskId);
    const payload: Record<string, string> = {};

    if (draft.country.trim()) {
      const country = parseCountryInput(draft.country);
      if (!country) return { payload, error: "Country must be 1–80 characters." };
      payload.country = country;
    }
    if (draft.year.trim()) {
      const year = parseYearInput(draft.year);
      if (!year) {
        return { payload, error: "Year founded must be a 4-digit year, 1800 to today." };
      }
      payload.yearEstablished = year;
    }
    if (draft.employees.trim()) {
      const employees = parseEmployeesInput(draft.employees);
      if (!employees) {
        return { payload, error: "Employees must be a whole number above zero." };
      }
      payload.employees = String(employees);
    }
    if (Object.keys(payload).length === 0) {
      return { payload, error: "Nothing to save yet." };
    }
    return { payload };
  }

  async function save(row: FlaggedRow) {
    const { payload, error: invalid } = validate(row);
    if (invalid) {
      setSaving((p) => ({
        ...p,
        [row.taskId]: { status: "error", message: invalid },
      }));
      return;
    }

    setSaving((p) => ({ ...p, [row.taskId]: { status: "saving" } }));
    try {
      const res = await fetch("/api/salesforce/account-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: row.accountId, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surfaced verbatim: an org with restricted country picklists rejects
        // unrecognised values, and the sender needs to see which value failed.
        setSaving((p) => ({
          ...p,
          [row.taskId]: {
            status: "error",
            message: body.error ?? `Salesforce rejected the update (${res.status}).`,
          },
        }));
        return;
      }
      setSaving((p) => ({ ...p, [row.taskId]: { status: "idle" } }));
      // Clear the draft: the saved fields come back as real values, so a stale
      // draft would leave Save enabled with nothing left to send.
      setDrafts((p) => {
        const next = { ...p };
        delete next[row.taskId];
        return next;
      });
      // Rescore: this row may now fall below the BS threshold and disappear.
      await load();
      onDataChanged?.();
    } catch (err) {
      setSaving((p) => ({
        ...p,
        [row.taskId]: {
          status: "error",
          message: err instanceof Error ? err.message : "Network error",
        },
      }));
    }
  }

  const description = thresholds
    ? `Outside ${thresholds.tierOneCountries.length} core countries · founded after ${thresholds.foundedAfterYear} · under ${thresholds.minEmployees} staff. Any ${thresholds.bsFlagCount} of the 3.`
    : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={target.title}
      description={description}
    >
      {!foundedAvailable && (
        <Alert variant="warn" className="mb-4">
          Year founded is unavailable in Salesforce, so these emails were scored
          on geography and headcount only.
        </Alert>
      )}

      {error && (
        <Alert variant="danger" title="Could not load" className="mb-4">
          {error}
        </Alert>
      )}

      {rows === null && <Spinner center label="Loading flagged emails…" />}

      {rows !== null && rows.length === 0 && !error && (
        <p className="py-10 text-center text-sm text-ink-muted">
          No flagged emails in this period. Every email went to a company that
          clears at least two of the three checks.
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <p className="mb-3 text-sm text-ink-secondary">
            {rows.length} flagged {rows.length === 1 ? "email" : "emails"}. An
            amber field is blank in Salesforce — fill in the real value and it
            saves straight to the account.
          </p>

          <Table>
            <Table.Head>
              <Table.HeadRow>
                <Table.HeadCell>Company</Table.HeadCell>
                <Table.HeadCell>Sent</Table.HeadCell>
                <Table.HeadCell>Sender</Table.HeadCell>
                <Table.HeadCell>Type</Table.HeadCell>
                <Table.HeadCell>Country</Table.HeadCell>
                <Table.HeadCell>Founded</Table.HeadCell>
                <Table.HeadCell className="text-right">Employees</Table.HeadCell>
                <Table.HeadCell></Table.HeadCell>
              </Table.HeadRow>
            </Table.Head>
            <Table.Body>
              {rows.map((row) => {
                const state = saving[row.taskId] ?? { status: "idle" };
                const missing = new Set(row.missing);
                const flagged = new Set(row.flags);
                const hasBlanks = row.missing.length > 0;
                const draft = draftFor(row.taskId);
                const dirty =
                  draft.country.trim() !== "" ||
                  draft.year.trim() !== "" ||
                  draft.employees.trim() !== "";

                return (
                  <Table.Row key={row.taskId}>
                    <Table.Cell>
                      <div className="font-medium text-ink">{row.accountName}</div>
                      {/* Two destinations: the company itself, and the record to
                          fix. No middot separator — this column is narrow, and a
                          wrapped middot dangles at the end of the line. */}
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                        {row.website && (
                          <a
                            href={
                              row.website.startsWith("http")
                                ? row.website
                                : `https://${row.website}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 whitespace-nowrap text-ink-muted hover:text-ink"
                          >
                            {prettyDomain(row.website)}
                            <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                          </a>
                        )}
                        <a
                          href={row.accountUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 whitespace-nowrap text-ink-muted hover:text-ink"
                        >
                          Salesforce
                          <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                        </a>
                      </div>
                    </Table.Cell>

                    <Table.Cell className="whitespace-nowrap tabular-nums text-ink-secondary">
                      {row.activityDate}
                    </Table.Cell>

                    <Table.Cell className="whitespace-nowrap text-ink-secondary">
                      {row.owner}
                    </Table.Cell>

                    <Table.Cell className="whitespace-nowrap text-ink-secondary">
                      {row.subjectType || "—"}
                    </Table.Cell>

                    <FieldCell
                      flagKey="geography"
                      isMissing={missing.has("geography")}
                      isFlagged={flagged.has("geography")}
                      value={row.country}
                      draft={draft.country}
                      placeholder="e.g. Canada"
                      onChange={(v) => setDraft(row.taskId, { country: v })}
                      disabled={state.status === "saving"}
                    />

                    <FieldCell
                      flagKey="founded"
                      isMissing={missing.has("founded")}
                      isFlagged={flagged.has("founded")}
                      value={row.yearEstablished}
                      draft={draft.year}
                      placeholder="e.g. 1998"
                      inputMode="numeric"
                      maxLength={4}
                      onChange={(v) => setDraft(row.taskId, { year: v })}
                      disabled={state.status === "saving"}
                    />

                    <FieldCell
                      flagKey="employees"
                      isMissing={missing.has("employees")}
                      isFlagged={flagged.has("employees")}
                      value={
                        row.numberOfEmployees != null && row.numberOfEmployees > 0
                          ? row.numberOfEmployees.toLocaleString()
                          : null
                      }
                      draft={draft.employees}
                      placeholder="e.g. 40"
                      inputMode="numeric"
                      align="right"
                      onChange={(v) => setDraft(row.taskId, { employees: v })}
                      disabled={state.status === "saving"}
                    />

                    <Table.Cell>
                      {hasBlanks && (
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!dirty || state.status === "saving"}
                            loading={state.status === "saving"}
                            leftIcon={
                              state.status === "saving" ? undefined : (
                                <Check className="h-3.5 w-3.5" strokeWidth={2} />
                              )
                            }
                            onClick={() => save(row)}
                          >
                            {state.status === "saving" ? "Saving…" : "Save"}
                          </Button>
                          {state.status === "error" && state.message && (
                            <span className="max-w-[16rem] text-right text-xs text-danger">
                              {state.message}
                            </span>
                          )}
                        </div>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </>
      )}
    </Modal>
  );
}

// ── One scored field: a red pill for a bad value, an amber input for a blank ──

function FieldCell({
  flagKey,
  isMissing,
  isFlagged,
  value,
  draft,
  placeholder,
  onChange,
  disabled,
  align = "left",
  inputMode,
  maxLength,
}: {
  flagKey: QualityFlagKey;
  isMissing: boolean;
  isFlagged: boolean;
  value: string | null;
  draft: string;
  placeholder: string;
  onChange: (v: string) => void;
  disabled: boolean;
  align?: "left" | "right";
  inputMode?: "numeric";
  maxLength?: number;
}) {
  const cellAlign = align === "right" ? "text-right" : "";

  // Blank in Salesforce: offer an input rather than just a verdict.
  if (isMissing) {
    return (
      <Table.Cell className={cellAlign}>
        <input
          type="text"
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={inputMode}
          maxLength={maxLength}
          aria-label={`${QUALITY_FLAG_LABELS[flagKey]} — not set in Salesforce`}
          className={`h-8 w-full min-w-[6rem] rounded-sm border border-warn/40 bg-warn-soft px-2 text-sm text-ink placeholder:text-warn/70 focus:border-warn focus:outline-none focus:ring-2 focus:ring-warn/25 disabled:cursor-not-allowed disabled:opacity-60 ${
            align === "right" ? "text-right tabular-nums" : ""
          }`}
        />
        <span className="mt-1 block text-[11px] font-medium uppercase tracking-wide text-warn">
          not set
        </span>
      </Table.Cell>
    );
  }

  // A real value. Red when it is the thing counting against the email.
  return (
    <Table.Cell className={cellAlign}>
      <span
        className={`${align === "right" ? "tabular-nums" : ""} ${
          isFlagged ? "font-medium text-danger" : "text-ink-secondary"
        }`}
      >
        {value ?? "—"}
      </span>
      {isFlagged && (
        <span className="mt-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-danger">
          <X className="h-3 w-3" strokeWidth={2.5} />
          {QUALITY_FLAG_LABELS[flagKey]}
        </span>
      )}
    </Table.Cell>
  );
}
