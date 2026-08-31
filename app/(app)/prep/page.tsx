"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import WeekSelector, {
  WeekRange,
  generateWeeks,
  currentWeekIndex,
} from "../../components/WeekSelector";
import ConnectSalesforce from "../../components/ConnectSalesforce";
import { PageHeader } from "@/app/components/ui/PageHeader";
import { PageContent } from "@/app/components/ui/PageContent";
import { useJobs, fetchJobResult } from "@/app/hooks/useJobs";

// ── One-pager localStorage cache ─────────────────────────────────────────────
const PREP_CACHE_KEY = "call_prep_cache";

function getOnePagerCache(): Record<string, OnePagerContent> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PREP_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOnePagerToCache(key: string, onePager: OnePagerContent) {
  if (typeof window === "undefined") return;
  try {
    const cache = getOnePagerCache();
    cache[key] = onePager;
    localStorage.setItem(PREP_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — non-critical
  }
}

// ── Meetings list localStorage cache (per-week) ──────────────────────────────
// Persists the loaded meetings list keyed by the WeekSelector's start date so
// revisiting /prep mid-week doesn't require a manual "Load" every time. The
// user controls freshness via the "Reload" button; no auto-refresh, no TTL.
const MEETINGS_CACHE_KEY = "call_prep_meetings_cache";
type CachedMeetings = { meetings: MeetingMatch[]; loadedAt: string };

function getMeetingsCache(): Record<string, CachedMeetings> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(MEETINGS_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMeetingsToCache(
  weekKey: string,
  meetings: MeetingMatch[],
  loadedAt: string,
): void {
  if (typeof window === "undefined") return;
  try {
    const cache = getMeetingsCache();
    cache[weekKey] = { meetings, loadedAt };
    localStorage.setItem(MEETINGS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — non-critical
  }
}

// "Loaded 10:42 AM" if today; "Loaded Mon 10:42 AM" otherwise. No new deps.
function formatLoadedAt(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (d.toDateString() === now.toDateString()) return `Loaded ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `Loaded ${day} ${time}`;
}

function getCacheKey(meeting: MeetingMatch): string | null {
  if (meeting.match) return meeting.match.accountId;
  if (meeting.externalDomains.length > 0) return meeting.externalDomains[0];
  return null;
}

// ── Server-side one-pager library ────────────────────────────────────────────
// Every generated one-pager is already stored in Supabase (jobs.result), but
// this page used to read them back only from localStorage — so a prep generated
// on a phone looked missing on a laptop and the Download button never appeared.
// /api/prep/library is that server read, keyed the same way as getCacheKey.
type PrepLibraryEntry = {
  key: string;
  onePager: OnePagerContent;
  prepMode: "first_call" | "reconnect";
  generatedAt: string;
};

// The server can only ever be equal or ahead of the local cache — every local
// entry was written from a job that also wrote to Supabase. We still compare
// timestamps so a prep generated in this session isn't overwritten by the
// library snapshot that was fetched back at mount.
function serverEntryWins(
  entry: PrepLibraryEntry,
  local: OnePagerContent | null,
): boolean {
  if (!local) return true;
  const localAt = local.generatedOn ? Date.parse(local.generatedOn) : NaN;
  const serverAt = Date.parse(entry.generatedAt);
  if (Number.isNaN(localAt)) return true;
  if (Number.isNaN(serverAt)) return false;
  return serverAt >= localAt;
}

// applyPrepMode() in the runner strips quickBrief / businessModel /
// relationshipCatchUp for First Calls, so their presence is a reliable signal
// that a locally cached one-pager was generated as a Reconnect. Used when we're
// falling back to localStorage and have no server record of the mode.
function inferPrepMode(
  onePager: OnePagerContent | null,
): "first_call" | "reconnect" {
  if (!onePager) return "first_call";
  const reconnectOnly = [
    onePager.quickBrief,
    onePager.businessModel,
    onePager.relationshipCatchUp,
  ];
  return reconnectOnly.some((v) => typeof v === "string" && v.trim().length > 0)
    ? "reconnect"
    : "first_call";
}

// Wrap a raw calendar meeting with this page's per-row state, restoring any
// one-pager we've already generated for it. Server library wins over the local
// cache; the local cache remains as the instant-paint / offline layer.
function hydrateMeeting(
  m: MeetingMatch,
  localCache: Record<string, OnePagerContent>,
  library: Record<string, PrepLibraryEntry> | null,
): PrepMeeting {
  const key = getCacheKey(m);
  const local = key ? (localCache[key] ?? null) : null;
  const entry = key && library ? (library[key] ?? null) : null;
  const useServer = entry !== null && serverEntryWins(entry, local);
  return {
    ...m,
    onePager: useServer ? entry.onePager : local,
    // This used to be hard-reset to "first_call", which silently downgraded a
    // Reconnect briefing — and its Word export — after any page refresh.
    prepMode: useServer ? entry.prepMode : inferPrepMode(local),
    generating: false,
    generateError: null,
    downloading: false,
    jobId: null,
    generationCacheKey: null,
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

type MeetingMatch = {
  eventId: string;
  subject: string;
  meetingDate: string;
  startTime: string;
  externalDomains: string[];
  match: {
    accountId: string;
    accountName: string;
    accountUrl: string;
  } | null;
  allMatches: Array<{
    accountId: string;
    accountName: string;
    accountUrl: string;
    domain: string;
  }>;
  alreadyLogged: boolean;
};

type OnePagerContent = {
  companyName: string;
  generatedOn?: string;
  quickBrief?: string;
  businessModel?: string;
  relationshipCatchUp?: string;
  whatTheyDo: string;
  customers: string;
  companyHistory: string;
  recentNews: string[];
};

type PrepMeeting = MeetingMatch & {
  onePager: OnePagerContent | null;
  generating: boolean;
  generateError: string | null;
  downloading: boolean;
  // Background-job id that's currently producing the one-pager for this row.
  // Cleared once the job has been synced into local state.
  jobId: string | null;
  generationCacheKey: string | null;
  prepMode: "first_call" | "reconnect";
};

// ── Page wrapper ─────────────────────────────────────────────────────────────

export default function PrepPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-navy" />}>
      <PrepPageContent />
    </Suspense>
  );
}

// ── Main page content ────────────────────────────────────────────────────────

function PrepPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Connection state
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);

  // Week & meetings
  const [selectedWeek, setSelectedWeek] = useState<WeekRange | null>(
    () => generateWeeks()[currentWeekIndex()]
  );
  const [meetings, setMeetings] = useState<PrepMeeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  // ISO timestamp of when the currently-shown meetings list was last fetched
  // from Outlook — feeds the "Loaded …" label next to the Reload button.
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  // Expanded row (to show one-pager preview)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Manual Salesforce account search (for unmatched meetings)
  const [manualMatches, setManualMatches] = useState<
    Map<string, { accountId: string; accountName: string; accountUrl: string; website?: string | null }>
  >(new Map());
  const [searchInputs, setSearchInputs] = useState<Map<string, string>>(
    new Map()
  );
  const [searchResults, setSearchResults] = useState<
    Map<
      string,
      Array<{
        accountId: string;
        accountName: string;
        accountUrl: string;
        website: string | null;
      }>
    >
  >(new Map());
  const [searchLoading, setSearchLoading] = useState<Set<string>>(new Set());
  // Rows whose (already-matched) account the user is currently re-picking. An
  // eventId in this set forces the search UI to show even though a match exists.
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());

  // One-pagers already generated on any device, from Supabase. Fetched once on
  // mount; merged into rows by the effect below.
  const [serverLibrary, setServerLibrary] = useState<Record<
    string,
    PrepLibraryEntry
  > | null>(null);

  // Weeks the page has auto-loaded this session. A ref (not state) so an Outlook
  // error can never put us in a reload loop.
  const autoLoadedWeeks = useRef<Set<string>>(new Set());
  const [needsAutoLoad, setNeedsAutoLoad] = useState<string | null>(null);

  // ── On mount: check connections ────────────────────────────────────────────
  useEffect(() => {
    const msOk = searchParams.get("ms_connected");
    const msErr = searchParams.get("ms_error");
    if (msOk || msErr) {
      router.replace("/prep");
    }
    checkConnections();
    loadServerLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadServerLibrary() {
    try {
      const res = await fetch("/api/prep/library");
      if (!res.ok) {
        setServerLibrary({});
        return;
      }
      const data = (await res.json()) as { entries?: PrepLibraryEntry[] };
      const map: Record<string, PrepLibraryEntry> = {};
      for (const entry of data.entries ?? []) {
        if (entry?.key && entry.onePager) map[entry.key] = entry;
      }
      setServerLibrary(map);
    } catch {
      // Non-critical: the page still works off the local cache, which is
      // exactly the old behaviour.
      setServerLibrary({});
    }
  }

  async function checkConnections() {
    try {
      const [sfRes, msRes] = await Promise.all([
        fetch("/api/salesforce/status"),
        fetch("/api/microsoft/status"),
      ]);
      if (sfRes.ok) {
        const sfData = await sfRes.json();
        setSfConnected(sfData.connected);
      }
      if (msRes.ok) {
        const msData = await msRes.json();
        setMsConnected(msData.connected);
      }
    } catch {
      setSfConnected(false);
      setMsConnected(false);
    }
  }

  // ── Load meetings for selected week ────────────────────────────────────────
  // ── Cache hydration ───────────────────────────────────────────────────────
  // On mount and whenever the user picks a different week, restore that week's
  // meetings from localStorage so they don't have to click "Load" again. If
  // there's no cached entry for this week, fall through to the empty state.
  useEffect(() => {
    if (!selectedWeek) return;
    const cached = getMeetingsCache()[selectedWeek.start];
    if (cached) {
      const oneCache = getOnePagerCache();
      setMeetings(
        cached.meetings.map((m) => hydrateMeeting(m, oneCache, serverLibrary)),
      );
      setHasLoaded(true);
      setLastLoadedAt(cached.loadedAt);
      setNeedsAutoLoad(null);
    } else {
      setMeetings([]);
      setHasLoaded(false);
      setLastLoadedAt(null);
      // Nothing cached for this week on this device. Rather than showing an
      // empty page, queue an auto-load — the effect below fires it as soon as
      // we know Outlook is connected. This is what makes a laptop opened before
      // a call show the week (and its already-generated preps) with no clicks.
      setNeedsAutoLoad(selectedWeek.start);
    }
    setExpandedId(null);
    // serverLibrary is intentionally omitted: it arrives async and is merged in
    // non-destructively by the effect below, so re-running this on its arrival
    // would needlessly reset in-flight row state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWeek]);

  // ── Auto-load a week with nothing cached locally ───────────────────────────
  useEffect(() => {
    if (!needsAutoLoad || msConnected !== true || loading) return;
    if (!selectedWeek || selectedWeek.start !== needsAutoLoad) return;
    if (autoLoadedWeeks.current.has(needsAutoLoad)) return;
    autoLoadedWeeks.current.add(needsAutoLoad);
    setNeedsAutoLoad(null);
    handleLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAutoLoad, msConnected, selectedWeek, loading]);

  // ── Merge the server library into rows once it arrives ─────────────────────
  // Non-destructive: only fills in a one-pager (and its prep mode) where the
  // server has something newer than what the row is already showing.
  useEffect(() => {
    if (!serverLibrary) return;
    setMeetings((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (m.generating) return m;
        const key = getCacheKey(m);
        const entry = key ? (serverLibrary[key] ?? null) : null;
        if (!entry || !serverEntryWins(entry, m.onePager)) return m;
        if (m.onePager === entry.onePager && m.prepMode === entry.prepMode) return m;
        changed = true;
        return { ...m, onePager: entry.onePager, prepMode: entry.prepMode };
      });
      return changed ? next : prev;
    });
  }, [serverLibrary]);

  async function handleLoad() {
    if (!selectedWeek) return;

    setLoading(true);
    setLoadError(null);
    setMeetings([]);
    setHasLoaded(false);
    setExpandedId(null);

    try {
      const res = await fetch(
        `/api/microsoft/calendar?start=${selectedWeek.start}&end=${selectedWeek.end}`
      );

      if (!res.ok) {
        const err = await res.json();
        if (err.error === "MS_NOT_CONNECTED") {
          setMsConnected(false);
          throw new Error("Outlook is not connected. Please connect first.");
        }
        throw new Error(err.error ?? "Failed to fetch calendar");
      }

      const data = await res.json();
      const raw: MeetingMatch[] = data.meetings ?? [];
      const cache = getOnePagerCache();

      // Persist for next visit — the same week now hydrates instantly.
      const loadedAt = new Date().toISOString();
      saveMeetingsToCache(selectedWeek.start, raw, loadedAt);
      setLastLoadedAt(loadedAt);

      // Wrap each meeting with prep-specific state, restoring one-pagers that
      // were already generated — from the server first, local cache second.
      setMeetings(raw.map((m) => hydrateMeeting(m, cache, serverLibrary)));
      setHasLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // ── Job-backed prep generation ────────────────────────────────────────────
  // Each meeting's "Generate" creates a `prep` job. This effect watches
  // useJobs and hydrates the per-row state when each job lands. Multiple
  // meetings can be generating in parallel; tracked via meeting.jobId.
  const { jobs, refetch: refetchJobs } = useJobs();
  const syncedPrepJobIds = useRef<Set<string>>(new Set());

  // Mirror of `meetings` so the effect below can see the current rows without
  // listing `meetings` as a dependency (it calls setMeetings, which would loop).
  const meetingsRef = useRef(meetings);
  useEffect(() => {
    meetingsRef.current = meetings;
  }, [meetings]);

  useEffect(() => {
    if (jobs.length === 0) return;

    // Sync pass: in-flight and failed rows need no payload.
    setMeetings((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (!m.jobId) return m;
        const job = jobs.find((j) => j.id === m.jobId);
        if (!job) return m;

        if (job.status === "queued" || job.status === "running") {
          // Still in flight — keep generating: true
          return m.generating ? m : { ...m, generating: true };
        }
        if (syncedPrepJobIds.current.has(job.id)) return m;

        if (job.status === "failed" || job.status === "cancelled") {
          syncedPrepJobIds.current.add(job.id);
          changed = true;
          return {
            ...m,
            generating: false,
            generateError: job.error ?? "Generation failed",
            jobId: null,
          };
        }
        return m;
      });
      return changed ? next : prev;
    });

    // Async pass: a finished one-pager now lives on /api/jobs/[id] rather than
    // on every poll of the list. Fetch each exactly once, then apply it.
    for (const m of meetingsRef.current) {
      if (!m.jobId) continue;
      const job = jobs.find((j) => j.id === m.jobId);
      if (!job || job.status !== "succeeded") continue;
      if (syncedPrepJobIds.current.has(job.id)) continue;
      syncedPrepJobIds.current.add(job.id);

      const jobId = job.id;
      void fetchJobResult(jobId).then((raw) => {
        const onePager =
          (raw as { onePager?: OnePagerContent }).onePager ?? null;
        setMeetings((prev) =>
          prev.map((row) => {
            if (row.jobId !== jobId) return row;
            const cacheKey = row.generationCacheKey ?? getCacheKey(row);
            if (cacheKey && onePager) saveOnePagerToCache(cacheKey, onePager);
            return {
              ...row,
              onePager,
              generating: false,
              generateError: null,
              jobId: null,
              generationCacheKey: null,
            };
          }),
        );
      });
    }
  }, [jobs]);

  // ── Cancel an in-flight prep job for one meeting row ─────────────────────
  async function handleCancelGenerate(eventId: string) {
    const meeting = meetings.find((m) => m.eventId === eventId);
    const jobId = meeting?.jobId ?? null;

    setMeetings((prev) =>
      prev.map((m) =>
        m.eventId === eventId
          ? { ...m, generating: false, jobId: null, generateError: null }
          : m,
      ),
    );

    if (jobId) {
      try {
        await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
      refetchJobs();
    }
  }

  // ── Generate one-pager for a meeting (creates a background job) ──────────
  async function handleGenerate(eventId: string) {
    const meeting = meetings.find((m) => m.eventId === eventId);
    if (!meeting) return;

    // Update state to show loading
    setMeetings((prev) =>
      prev.map((m) =>
        m.eventId === eventId
          ? { ...m, generating: true, generateError: null }
          : m
      )
    );

    const payload: Record<string, string> = {};

    // Manual link ALWAYS wins over the auto-detected match — otherwise the
    // research/scrape would target the email's original domain instead of the
    // company the user just chose (e.g. PE Norvestor's email manually relinked
    // to Pinja must research Pinja, not Norvestor).
    const manualMatch = manualMatches.get(meeting.eventId) ?? null;
    const sfMatch = manualMatch ?? meeting.match;
    if (sfMatch) {
      payload.accountId = sfMatch.accountId;
      payload.accountName = sfMatch.accountName;
    }

    if (manualMatch) {
      // Manual override: scrape the linked Salesforce account's website. Email-
      // derived domains/matches come from the wrong company and must be ignored.
      if (manualMatch.website) payload.website = manualMatch.website;
    } else {
      // Auto path: prefer a domain from the email's external matches.
      const matchWithWebsite = meeting.allMatches.find((m) => m.domain);
      if (matchWithWebsite) {
        payload.domain = matchWithWebsite.domain;
      } else if (meeting.externalDomains.length > 0) {
        payload.domain = meeting.externalDomains[0];
      }
      // Fallback: Salesforce account URL when no other domain is available.
      if (!payload.domain && !payload.website && sfMatch?.accountUrl) {
        payload.website = sfMatch.accountUrl;
      }
    }

    const labelName =
      payload.accountName || payload.domain || payload.website || "Meeting";
    payload.prepMode = meeting.prepMode;

    try {
      const res = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "prep",
          input: payload,
          label: `Call prep: ${labelName}`,
          resultRoute: `/prep`,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to start generation");
      }

      const data = (await res.json()) as { jobId: string };
      // Stamp the jobId on the meeting so useEffect can sync the result
      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId
            ? { ...m, jobId: data.jobId, generationCacheKey: sfMatch?.accountId ?? null }
            : m,
        ),
      );
      // Auto-expand the row so the user sees progress
      setExpandedId(eventId);
      refetchJobs();
    } catch (err) {
      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId
            ? {
                ...m,
                generating: false,
                generateError:
                  err instanceof Error ? err.message : "Unexpected error",
              }
            : m
        )
      );
    }
  }

  // ── Download one-pager as Word doc ─────────────────────────────────────────
  async function handleDownload(eventId: string) {
    const meeting = meetings.find((m) => m.eventId === eventId);
    if (!meeting?.onePager) return;

    setMeetings((prev) =>
      prev.map((m) =>
        m.eventId === eventId ? { ...m, downloading: true } : m
      )
    );

    try {
      const res = await fetch("/api/prep/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...meeting.onePager,
          prepMode: meeting.prepMode,
        }),
      });

      if (!res.ok) throw new Error("Download failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Call Prep - ${meeting.onePager.companyName}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Silently fail — button state will reset
    } finally {
      setMeetings((prev) =>
        prev.map((m) =>
          m.eventId === eventId ? { ...m, downloading: false } : m
        )
      );
    }
  }

  // ── Disconnect handlers ────────────────────────────────────────────────────
  async function handleSfDisconnect() {
    await fetch("/api/salesforce/status", { method: "DELETE" });
    setSfConnected(false);
  }

  async function handleMsDisconnect() {
    await fetch("/api/microsoft/status", { method: "DELETE" });
    setMsConnected(false);
    setMeetings([]);
    setHasLoaded(false);
    setLastLoadedAt(null);
    // Wipe cached meetings so a fresh Outlook connection starts clean.
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(MEETINGS_CACHE_KEY);
      } catch {
        /* non-critical */
      }
    }
  }

  // ── Manual Salesforce account search ──────────────────────────────────────
  async function handleAccountSearch(eventId: string) {
    const query = searchInputs.get(eventId)?.trim();
    if (!query || query.length < 2) return;

    setSearchLoading((prev) => new Set(prev).add(eventId));
    try {
      const res = await fetch(
        `/api/salesforce/search-accounts?q=${encodeURIComponent(query)}`
      );
      if (res.ok) {
        const data = await res.json();
        setSearchResults(
          (prev) => new Map(prev).set(eventId, data.accounts ?? [])
        );
      }
    } finally {
      setSearchLoading((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  }

  function handleSelectSearchResult(
    eventId: string,
    account: { accountId: string; accountName: string; accountUrl: string; website?: string | null }
  ) {
    setManualMatches((prev) => new Map(prev).set(eventId, account));
    setSearchResults((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    setSearchInputs((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    // Picking a result also exits "change" mode for an already-matched row.
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
  }

  // Enter "change account" mode for an already-matched row. Pre-fills the search
  // box with the current name so the user can tweak it.
  function handleStartEdit(eventId: string, currentName: string) {
    setEditingIds((prev) => new Set(prev).add(eventId));
    setSearchInputs((prev) => new Map(prev).set(eventId, currentName));
  }

  // Exit "change account" mode, keeping whatever match was already in place.
  function handleCancelEdit(eventId: string) {
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(eventId);
      return next;
    });
    setSearchResults((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
    setSearchInputs((prev) => {
      const next = new Map(prev);
      next.delete(eventId);
      return next;
    });
  }

  const msReady = msConnected === true;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Call Prep"
        actions={
          <>
            {msConnected === true ? (
              <button
                onClick={handleMsDisconnect}
                className="inline-flex items-center gap-2 text-sm text-ok bg-ok-soft border border-ok/20 rounded-md px-3 h-9 hover:bg-ok-soft/70 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-ok" />
                Outlook
              </button>
            ) : msConnected === false ? (
              <a
                href="/api/microsoft/connect"
                className="inline-flex items-center gap-2 bg-info hover:bg-info/90 text-white text-sm font-medium px-4 h-9 rounded-md transition-colors"
              >
                Connect Outlook
              </a>
            ) : null}
            <ConnectSalesforce
              connected={sfConnected === true}
              onDisconnect={handleSfDisconnect}
            />
          </>
        }
      />
      <PageContent>
        {/* Loading connections */}
        {(sfConnected === null || msConnected === null) && (
          <div className="flex justify-center items-center py-24">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-orange" />
          </div>
        )}

        {/* Connection prompts */}
        {msConnected === false && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center mb-6">
            <p className="text-blue-800 font-medium mb-2">
              Outlook is not connected.
            </p>
            <p className="text-blue-600 text-sm mb-4">
              Connect your Microsoft account so the app can read your calendar.
            </p>
            <a
              href="/api/microsoft/connect"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Outlook
            </a>
          </div>
        )}

        {sfConnected === false && msConnected !== false && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center mb-6">
            <p className="text-amber-800 font-medium mb-2">
              Salesforce is not connected.
            </p>
            <p className="text-amber-600 text-sm mb-4">
              Connect Salesforce for richer company data in your one-pagers. You
              can still generate briefings without it.
            </p>
            <a
              href="/api/salesforce/connect"
              className="inline-block bg-brand-orange hover:bg-brand-orange-hover text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors"
            >
              Connect Salesforce
            </a>
          </div>
        )}

        {/* Main UI — Outlook must be connected */}
        {msReady && (
          <>
            {/* Controls bar */}
            <div className="mb-5 flex flex-col items-stretch gap-4 md:mb-6 md:flex-row md:items-center md:justify-between">
              <div className="hidden md:block">
                <h2 className="text-xl font-semibold text-navy">Call Prep</h2>
                <p className="text-sm text-gray-400 mt-0.5">
                  Prepare one-pager briefings for your upcoming meetings
                </p>
              </div>

              <div className="flex w-full flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm md:w-auto md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
                <WeekSelector
                  selected={selectedWeek}
                  onChange={(week) => {
                    // The cache-hydration effect (keyed on selectedWeek) handles
                    // meetings / hasLoaded / lastLoadedAt for the new week.
                    setSelectedWeek(week);
                  }}
                />
                {hasLoaded && lastLoadedAt && (
                  <span className="text-center text-xs text-gray-400 md:text-left">
                    {formatLoadedAt(lastLoadedAt)}
                  </span>
                )}
                <button
                  onClick={handleLoad}
                  disabled={loading}
                  className="min-h-11 w-full rounded-lg bg-brand-orange px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-orange-hover disabled:opacity-50 md:min-h-0 md:w-auto"
                >
                  {loading
                    ? "Loading..."
                    : hasLoaded
                      ? "Reload meetings"
                      : "Load Meetings"}
                </button>
              </div>
            </div>

            {/* Error */}
            {loadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 text-sm text-red-700">
                {loadError}
              </div>
            )}

            {/* Loading spinner */}
            {loading && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange" />
                <p className="text-sm text-gray-400">
                  Fetching calendar events and matching to Salesforce...
                </p>
              </div>
            )}

            {/* Results table */}
            {!loading && hasLoaded && (
              <>
                <div className="text-sm text-gray-400 mb-3">
                  {meetings.length} external meeting
                  {meetings.length !== 1 ? "s" : ""} found
                </div>

                {meetings.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <p className="font-medium">
                      No external meetings found for this week.
                    </p>
                    <p className="text-sm mt-1">
                      Try a different week or check that your Outlook calendar
                      has meetings with external attendees.
                    </p>
                  </div>
                ) : (
                  <div className="md:overflow-hidden md:rounded-xl md:border md:border-gray-200 md:bg-white md:shadow-sm">
                    <table className="block w-full text-sm md:table">
                      <thead className="hidden md:table-header-group">
                        <tr className="bg-navy text-white text-xs font-semibold uppercase tracking-wider">
                          <th className="px-4 py-3 text-left w-10">#</th>
                          <th className="px-4 py-3 text-left">Meeting</th>
                          <th className="px-4 py-3 text-left w-28">Date</th>
                          <th className="px-4 py-3 text-left">Account</th>
                          <th className="px-4 py-3 text-left w-20">SF</th>
                          <th className="px-4 py-3 text-center w-48">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="block md:table-row-group">
                        {meetings.map((meeting, idx) => (
                          <MeetingRow
                            key={meeting.eventId}
                            meeting={meeting}
                            index={idx}
                            expanded={expandedId === meeting.eventId}
                            onToggleExpand={() =>
                              setExpandedId(
                                expandedId === meeting.eventId
                                  ? null
                                  : meeting.eventId
                              )
                            }
                            onGenerate={() => handleGenerate(meeting.eventId)}
                            onModeChange={(prepMode) =>
                              setMeetings((prev) => prev.map((m) =>
                                m.eventId === meeting.eventId ? { ...m, prepMode } : m,
                              ))
                            }
                            onCancelGenerate={() =>
                              handleCancelGenerate(meeting.eventId)
                            }
                            onDownload={() => handleDownload(meeting.eventId)}
                            manualMatch={manualMatches.get(meeting.eventId) ?? null}
                            searchInput={searchInputs.get(meeting.eventId) ?? ""}
                            searchResult={searchResults.get(meeting.eventId) ?? null}
                            isSearchLoading={searchLoading.has(meeting.eventId)}
                            isEditing={editingIds.has(meeting.eventId)}
                            onSearchInputChange={(val) =>
                              setSearchInputs((prev) => new Map(prev).set(meeting.eventId, val))
                            }
                            onSearch={() => handleAccountSearch(meeting.eventId)}
                            onSelectResult={(account) =>
                              handleSelectSearchResult(meeting.eventId, account)
                            }
                            onStartEdit={(currentName) =>
                              handleStartEdit(meeting.eventId, currentName)
                            }
                            onCancelEdit={() => handleCancelEdit(meeting.eventId)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {/* Prompt to load */}
            {!loading && !hasLoaded && !loadError && (
              <div className="text-center py-16 text-gray-400">
                <div className="text-5xl mb-4">
                  <svg
                    className="w-16 h-16 mx-auto text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                </div>
                <p className="font-medium">
                  Select a week and click &quot;Load Meetings&quot;
                </p>
                <p className="text-sm mt-1">
                  We&apos;ll pull your Outlook calendar and show external
                  meetings you can prepare for
                </p>
              </div>
            )}
          </>
        )}
      </PageContent>
    </>
  );
}

// ── Meeting Row Component ────────────────────────────────────────────────────

function MeetingRow({
  meeting,
  index,
  expanded,
  onToggleExpand,
  onGenerate,
  onModeChange,
  onCancelGenerate,
  onDownload,
  manualMatch,
  searchInput,
  searchResult,
  isSearchLoading,
  isEditing,
  onSearchInputChange,
  onSearch,
  onSelectResult,
  onStartEdit,
  onCancelEdit,
}: {
  meeting: PrepMeeting;
  index: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onGenerate: () => void;
  onModeChange: (mode: "first_call" | "reconnect") => void;
  onCancelGenerate: () => void;
  onDownload: () => void;
  manualMatch: { accountId: string; accountName: string; accountUrl: string; website?: string | null } | null;
  searchInput: string;
  searchResult: Array<{ accountId: string; accountName: string; accountUrl: string; website: string | null }> | null;
  isSearchLoading: boolean;
  isEditing: boolean;
  onSearchInputChange: (val: string) => void;
  onSearch: () => void;
  onSelectResult: (account: { accountId: string; accountName: string; accountUrl: string; website?: string | null }) => void;
  onStartEdit: (currentName: string) => void;
  onCancelEdit: () => void;
}) {
  const hasOnePager = meeting.onePager !== null;
  // Manual pick wins over the auto-detected match — consistent with how
  // handleGenerate resolves which account to research.
  const effectiveMatch = manualMatch ?? meeting.match;
  // Show the search UI when there's nothing matched yet, OR the user clicked
  // "Change" to re-pick an already-matched account.
  const showSearch = !effectiveMatch || isEditing;

  return (
    <>
      {/* Main row */}
      <tr
        className={`block overflow-hidden border border-gray-200 bg-white shadow-sm transition-colors hover:bg-gray-50 md:table-row md:rounded-none md:border-x-0 md:border-b-0 md:border-t md:border-gray-100 md:shadow-none ${
          expanded ? "rounded-t-xl" : "mb-3 rounded-xl"
        }`}
      >
        <td className="hidden px-4 py-3 font-mono text-xs text-gray-400 md:table-cell">
          {index + 1}
        </td>
        <td className="block px-4 pb-3 pt-4 md:table-cell md:py-3">
          <div className="text-base font-semibold leading-snug text-navy md:text-sm md:font-medium">
            {meeting.subject}
          </div>
          {meeting.startTime && (
            <div className="mt-0.5 hidden text-xs text-gray-400 md:block">
              {meeting.startTime}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 md:hidden">
            <span className="rounded-full bg-gray-100 px-2.5 py-1">
              {meeting.meetingDate}
            </span>
            {meeting.startTime && (
              <span className="rounded-full bg-gray-100 px-2.5 py-1">
                {meeting.startTime}
              </span>
            )}
          </div>
        </td>
        <td className="hidden px-4 py-3 text-gray-600 md:table-cell">{meeting.meetingDate}</td>
        <td className="block border-t border-gray-100 px-4 py-3 md:table-cell md:border-0">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 md:hidden">
            Salesforce account
          </div>
          {!showSearch && effectiveMatch ? (
            /* Matched account (auto or manually linked) */
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-navy">
                {effectiveMatch.accountName}
              </span>
              {manualMatch && (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs text-green-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Manually linked
                </span>
              )}
              <button
                onClick={() => onStartEdit(effectiveMatch.accountName)}
                className="text-xs text-gray-400 underline underline-offset-2 transition-colors hover:text-brand-orange"
              >
                Change
              </button>
              <a
                href={effectiveMatch.accountUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-blue-600 hover:border-blue-300 hover:text-blue-800 md:hidden"
              >
                Open SF
              </a>
            </div>
          ) : (
            /* No match yet, or user is re-picking — show search UI */
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={searchInput}
                  placeholder={meeting.externalDomains.length > 0 ? meeting.externalDomains[0].split(".")[0] : "Search account..."}
                  onChange={(e) => onSearchInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onSearch();
                    }
                  }}
                  autoFocus={isEditing}
                  className="min-h-11 w-full min-w-0 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange md:min-h-0 md:flex-1 md:px-2 md:py-1"
                />
                <button
                  onClick={onSearch}
                  disabled={isSearchLoading}
                  className="min-h-10 flex-1 rounded bg-navy px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-navy/80 disabled:opacity-50 md:min-h-0 md:flex-none md:px-2 md:py-1"
                >
                  {isSearchLoading ? "..." : "Search"}
                </button>
                {isEditing && effectiveMatch && (
                  <button
                    onClick={onCancelEdit}
                    className="min-h-10 flex-1 text-xs text-gray-400 underline underline-offset-2 transition-colors hover:text-red-500 md:min-h-0 md:flex-none"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {meeting.externalDomains.length > 0 && !searchInput && (
                <span className="text-xs text-gray-300">
                  {meeting.externalDomains.join(", ")}
                </span>
              )}
              {/* Search results dropdown */}
              {searchResult && (
                <div className="border border-gray-200 rounded bg-white shadow-lg max-h-32 overflow-y-auto">
                  {searchResult.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-gray-400 italic">No accounts found</div>
                  ) : (
                    searchResult.map((account) => (
                      <button
                        key={account.accountId}
                        onClick={() => onSelectResult(account)}
                        className="w-full text-left px-2 py-1.5 text-sm hover:bg-blue-50 hover:text-blue-700 border-b border-gray-100 last:border-0 transition-colors"
                      >
                        {account.accountName}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </td>
        <td className="hidden px-4 py-3 md:table-cell">
          {effectiveMatch ? (
            <a
              href={effectiveMatch.accountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 text-xs font-medium"
            >
              Open
            </a>
          ) : (
            <span className="text-gray-300 text-xs">—</span>
          )}
        </td>
        <td className="block border-t border-gray-100 px-4 py-3 md:table-cell md:border-0">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 md:hidden">
            Briefing
          </div>
          <div className="flex w-full flex-col gap-2 md:flex-row md:items-center md:justify-center">
            <select
              value={meeting.prepMode}
              onChange={(e) => onModeChange(e.target.value as "first_call" | "reconnect")}
              disabled={meeting.generating}
              className="min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-navy md:min-h-0 md:w-auto md:rounded md:px-2 md:py-1.5 md:text-xs"
              aria-label="Briefing mode"
            >
              <option value="first_call">First Call</option>
              <option value="reconnect">Reconnect</option>
            </select>
            {/* Generate button (shown when no one-pager exists) */}
            {!hasOnePager && !meeting.generating && (
              <button
                onClick={onGenerate}
                className="min-h-11 w-full rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-orange-hover md:min-h-0 md:w-auto md:px-3 md:py-1.5 md:text-xs"
              >
                Generate
              </button>
            )}

            {/* Generating spinner + Cancel link */}
            {meeting.generating && (
              <div className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-gray-50 px-3 text-xs text-gray-500 md:min-h-0 md:w-auto md:bg-transparent md:px-0">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-orange" />
                Generating...
                <button
                  onClick={onCancelGenerate}
                  className="ml-1 text-gray-400 hover:text-red-500 underline underline-offset-2 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Error */}
            {meeting.generateError && (
              <div className="flex w-full flex-col items-stretch gap-2 md:w-auto md:flex-row md:items-center">
                <span className="text-xs text-red-500">
                  {meeting.generateError}
                </span>
                <button
                  onClick={onGenerate}
                  className="min-h-10 rounded-lg border border-brand-orange/30 px-3 text-xs font-semibold text-brand-orange hover:bg-orange-50 md:min-h-0 md:border-0 md:px-0 md:hover:bg-transparent md:hover:underline"
                >
                  Retry
                </button>
              </div>
            )}

            {/* After generation: Regenerate + View + Download */}
            {hasOnePager && !meeting.generating && (
              <>
                <button
                  onClick={onGenerate}
                  className="min-h-10 w-full rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-500 transition-colors hover:border-brand-orange hover:text-brand-orange md:min-h-0 md:w-auto md:border-0 md:px-0 md:text-gray-400"
                  title="Regenerate one-pager"
                >
                  <span className="md:hidden">Regenerate</span>
                  <span className="hidden md:inline">↻</span>
                </button>
                <button
                  onClick={onToggleExpand}
                  className="min-h-10 w-full rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-navy transition-colors hover:border-brand-orange hover:text-brand-orange md:min-h-0 md:w-auto md:px-2 md:py-1.5"
                >
                  {expanded ? "Hide" : "View"}
                </button>
                <button
                  onClick={onDownload}
                  disabled={meeting.downloading}
                  className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-navy px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-navy-dark disabled:opacity-50 md:min-h-0 md:w-auto md:py-1.5"
                >
                  {meeting.downloading ? (
                    <>
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      Word
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded preview row */}
      {expanded && meeting.onePager && (
        <tr className="mb-3 block md:table-row md:mb-0">
          <td
            colSpan={6}
            className="block rounded-b-xl border border-t-0 border-gray-200 bg-gray-50 px-4 py-5 md:table-cell md:rounded-none md:border-x-0 md:border-b-0 md:border-t md:border-gray-100 md:py-6"
          >
            <div className="max-w-3xl mx-auto">
              <h3 className="text-lg font-semibold text-navy mb-4">
                {meeting.onePager.companyName}
              </h3>
              {meeting.onePager.generatedOn && (
                <p className="-mt-3 mb-4 text-xs text-gray-400">
                  Generated {new Date(meeting.onePager.generatedOn).toLocaleString()}
                </p>
              )}

              {meeting.prepMode === "reconnect" && meeting.onePager.quickBrief && (
                <div className="mb-4 rounded-lg border border-brand-orange/30 bg-orange-50 p-4">
                  <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">60-Second Brief</h4>
                  <p className="text-sm text-gray-700 leading-relaxed">{meeting.onePager.quickBrief}</p>
                </div>
              )}

              {meeting.prepMode === "reconnect" && meeting.onePager.businessModel && (
                <div className="mb-4">
                  <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">Business Model</h4>
                  <p className="text-sm text-gray-700 leading-relaxed">{meeting.onePager.businessModel}</p>
                </div>
              )}

              {meeting.prepMode === "reconnect" && meeting.onePager.relationshipCatchUp && (
                <div className="mb-4">
                  <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">Relationship Catch-Up</h4>
                  <p className="text-sm text-gray-700 leading-relaxed">{meeting.onePager.relationshipCatchUp}</p>
                </div>
              )}

              {/* What They Do */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  What They Do
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.whatTheyDo}
                </p>
              </div>

              {/* Customers & Use Case */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Customers & Use Case
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.customers}
                </p>
              </div>

              {/* Company History */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Company History
                </h4>
                <p className="text-sm text-gray-700 leading-relaxed">
                  {meeting.onePager.companyHistory}
                </p>
              </div>

              {/* Recent News */}
              <div className="mb-2">
                <h4 className="text-sm font-semibold text-navy uppercase tracking-wide mb-1">
                  Recent News
                </h4>
                {meeting.onePager.recentNews.length > 0 ? (
                  <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                    {meeting.onePager.recentNews.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-400 italic">
                    No recent news found.
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
