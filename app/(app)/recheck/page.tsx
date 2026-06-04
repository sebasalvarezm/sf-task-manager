"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ListChecks,
  ExternalLink,
  AlertCircle,
  Clock,
} from "lucide-react";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { Button } from "@/app/components/ui/Button";
import { Card } from "@/app/components/ui/Card";
import { Alert } from "@/app/components/ui/Alert";
import { Badge } from "@/app/components/ui/Badge";

// Shape returned by /api/salesforce/recheck (mirrors RecheckRow in lib).
type RecheckRow = {
  input: string;
  status: "matched" | "multiple" | "not_found";
  accountId: string | null;
  accountName: string | null;
  accountUrl: string | null;
  owner: string | null;
  matchCount: number;
  lastTaskDate: string | null;
  daysSince: number | null;
  readyToRecontact: boolean;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function RecheckPage() {
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<RecheckRow[] | null>(null);
  const [thresholdDays, setThresholdDays] = useState(60);

  useEffect(() => {
    fetch("/api/salesforce/status")
      .then((r) => r.json())
      .then((d) => setSfConnected(Boolean(d.connected)))
      .catch(() => setSfConnected(false));
  }, []);

  // Parsed preview of how many names will be checked (trim + drop blanks + dedupe).
  const parsedNames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const name = line.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }, [text]);

  const readyCount = useMemo(
    () => (rows ?? []).filter((r) => r.readyToRecontact).length,
    [rows]
  );

  async function handleCheck() {
    if (parsedNames.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/salesforce/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: parsedNames }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Check failed");
      setRows(data.rows as RecheckRow[]);
      if (typeof data.thresholdDays === "number") setThresholdDays(data.thresholdDays);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — try again");
    } finally {
      setLoading(false);
    }
  }

  // ── Connection gate ──────────────────────────────────────────────────────
  if (sfConnected === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-ink-muted text-sm">Checking connection…</p>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Re-Contact"
        subtitle="Paste a column of company names from Excel — see when each was last contacted in Salesforce and who's gone quiet long enough for a fresh email."
      />
      <PageContent>
        {!sfConnected ? (
          <Card>
            <div className="p-2 text-center">
              <h2 className="text-lg font-semibold text-ink mb-1">
                Connect Salesforce to get started
              </h2>
              <p className="text-sm text-ink-muted">
                This tool looks up the last logged task for each account, so a
                Salesforce connection is required.
              </p>
            </div>
          </Card>
        ) : (
          <>
            {/* Paste box */}
            <Card>
              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium text-ink">
                  Company names — one per line
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={"Acme Materials\nNorthstar Aggregates\nO'Brien Concrete\n…"}
                  rows={8}
                  disabled={loading}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:bg-surface-3 resize-y font-mono"
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-ink-muted">
                    {parsedNames.length === 0
                      ? "Paste straight from your Excel column."
                      : `${parsedNames.length} compan${parsedNames.length === 1 ? "y" : "ies"} to check · quiet for ${thresholdDays}+ days = ready to re-contact`}
                  </p>
                  <Button
                    variant="primary"
                    loading={loading}
                    disabled={parsedNames.length === 0}
                    onClick={handleCheck}
                    leftIcon={<ListChecks className="h-4 w-4" strokeWidth={1.75} />}
                    className="shrink-0"
                  >
                    {loading ? "Checking…" : "Check activity"}
                  </Button>
                </div>
                {error && <Alert variant="danger">{error}</Alert>}
              </div>
            </Card>

            {/* Results */}
            {rows && (
              <Card>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-sm text-ink-secondary">
                    <Badge variant="warn" dot>
                      {readyCount} ready to re-contact
                    </Badge>
                    <span className="text-ink-muted">
                      of {rows.length} checked
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-ink-muted border-b border-line">
                          <th className="py-2 pr-4 font-medium">Company</th>
                          <th className="py-2 pr-4 font-medium">Matched account</th>
                          <th className="py-2 pr-4 font-medium">Last task</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">Owner</th>
                          <th className="py-2 font-medium">Salesforce</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr
                            key={`${r.input}-${i}`}
                            className="border-b border-line/60 last:border-0 align-top"
                          >
                            <td className="py-2.5 pr-4 text-ink">{r.input}</td>
                            <td className="py-2.5 pr-4">
                              {r.status === "not_found" ? (
                                <span className="text-ink-muted">—</span>
                              ) : (
                                <span className="text-ink">
                                  {r.accountName}
                                  {r.status === "multiple" && (
                                    <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-warn">
                                      <AlertCircle className="h-3 w-3" strokeWidth={2} />
                                      {r.matchCount} matches — verify
                                    </span>
                                  )}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 pr-4 whitespace-nowrap text-ink-secondary">
                              {r.status === "not_found"
                                ? "—"
                                : r.lastTaskDate
                                  ? fmtDate(r.lastTaskDate)
                                  : "No tasks logged"}
                            </td>
                            <td className="py-2.5 pr-4 whitespace-nowrap">
                              {r.status === "not_found" ? (
                                <Badge variant="danger" icon={<AlertCircle className="h-3 w-3" />}>
                                  Not found
                                </Badge>
                              ) : r.readyToRecontact ? (
                                <Badge variant="warn" icon={<Clock className="h-3 w-3" />}>
                                  {r.lastTaskDate
                                    ? `Ready · ${r.daysSince}d`
                                    : "Ready · never"}
                                </Badge>
                              ) : (
                                <Badge variant="ok">Recent · {r.daysSince}d</Badge>
                              )}
                            </td>
                            <td className="py-2.5 pr-4 whitespace-nowrap text-ink-secondary">
                              {r.owner ?? "—"}
                            </td>
                            <td className="py-2.5 whitespace-nowrap">
                              {r.accountUrl ? (
                                <a
                                  href={r.accountUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-brand hover:underline"
                                >
                                  Open
                                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                                </a>
                              ) : (
                                <span className="text-ink-muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}
