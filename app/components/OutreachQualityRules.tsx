"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Alert } from "./ui/Alert";
import {
  canonicalizeCountry,
  type QualityThresholds,
} from "@/lib/outreach-quality";

// Admin editor for the outreach quality ("BS") scoring rules. Persists to
// app_settings via /api/settings/outreach-quality, so the business rules move
// without a deploy.

type Props = {
  open: boolean;
  onClose: () => void;
  /** Current values, echoed by the stats response. */
  thresholds: QualityThresholds | null;
  /** Called after a successful save so the page reloads its stats. */
  onSaved: () => void;
};

export function OutreachQualityRules({
  open,
  onClose,
  thresholds,
  onSaved,
}: Props) {
  const [countries, setCountries] = useState<string[]>([]);
  const [newCountry, setNewCountry] = useState("");
  const [foundedAfterYear, setFoundedAfterYear] = useState("");
  const [minEmployees, setMinEmployees] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form to the live values each time the dialog opens.
  useEffect(() => {
    if (!open || !thresholds) return;
    setCountries([...thresholds.tierOneCountries]);
    setFoundedAfterYear(String(thresholds.foundedAfterYear));
    setMinEmployees(String(thresholds.minEmployees));
    setNewCountry("");
    setError(null);
  }, [open, thresholds]);

  function addCountry() {
    const canonical = canonicalizeCountry(newCountry);
    if (!canonical) return;
    // Compare canonically so "USA" is not added next to "United States".
    const already = countries.some(
      (c) => canonicalizeCountry(c)?.toLowerCase() === canonical.toLowerCase(),
    );
    if (!already) setCountries((prev) => [...prev, canonical]);
    setNewCountry("");
  }

  async function save() {
    const year = Number(foundedAfterYear);
    const employees = Number(minEmployees);

    if (!Number.isInteger(year) || year < 1800 || year > new Date().getFullYear()) {
      setError("Founded-after year must be a 4-digit year, 1800 to today.");
      return;
    }
    if (!Number.isInteger(employees) || employees < 1) {
      setError("Minimum headcount must be a whole number above zero.");
      return;
    }
    if (countries.length === 0) {
      setError("Keep at least one core country — an empty list flags every email.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/outreach-quality", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tierOneCountries: countries,
          foundedAfterYear: year,
          minEmployees: employees,
          bsFlagCount: thresholds?.bsFlagCount ?? 2,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Could not save (${res.status}).`);
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Outreach quality rules"
      description="An email is flagged when any two of the three checks fail."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {saving ? "Saving…" : "Save rules"}
          </Button>
        </>
      }
    >
      {error && (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <Alert variant="info" className="mb-5">
        Changing a rule re-scores history, so past weeks will move too.
      </Alert>

      <div className="space-y-6">
        <section>
          <h3 className="text-sm font-medium text-ink">Core countries</h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            A company headquartered anywhere else fails the geography check.
            Spelling variants are matched automatically.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {countries.map((country) => (
              <span
                key={country}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-white py-1 pl-2.5 pr-1.5 text-sm text-ink"
              >
                {country}
                <button
                  type="button"
                  onClick={() =>
                    setCountries((prev) => prev.filter((c) => c !== country))
                  }
                  className="rounded-sm p-0.5 text-ink-muted transition-colors hover:bg-surface-3 hover:text-danger"
                  aria-label={`Remove ${country}`}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </span>
            ))}
            {countries.length === 0 && (
              <span className="text-sm text-danger">
                No countries — every email would fail geography.
              </span>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <Input
              value={newCountry}
              onChange={(e) => setNewCountry(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCountry();
                }
              }}
              placeholder="Add a country"
              className="max-w-xs"
            />
            <Button
              variant="secondary"
              onClick={addCountry}
              disabled={!newCountry.trim()}
              leftIcon={<Plus className="h-4 w-4" strokeWidth={2} />}
            >
              Add
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="oq-year"
              className="block text-sm font-medium text-ink"
            >
              Founded after
            </label>
            <p className="mt-0.5 mb-2 text-xs text-ink-muted">
              Companies founded later than this fail. The year itself passes.
            </p>
            <Input
              id="oq-year"
              value={foundedAfterYear}
              onChange={(e) => setFoundedAfterYear(e.target.value)}
              inputMode="numeric"
              maxLength={4}
              className="max-w-[8rem] tabular-nums"
            />
          </div>

          <div>
            <label
              htmlFor="oq-employees"
              className="block text-sm font-medium text-ink"
            >
              Minimum headcount
            </label>
            <p className="mt-0.5 mb-2 text-xs text-ink-muted">
              Fewer than this fails. This number itself passes.
            </p>
            <Input
              id="oq-employees"
              value={minEmployees}
              onChange={(e) => setMinEmployees(e.target.value)}
              inputMode="numeric"
              className="max-w-[8rem] tabular-nums"
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
