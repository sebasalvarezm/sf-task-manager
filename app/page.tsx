"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LandingPage() {
  const router = useRouter();
  const [sfConnected, setSfConnected] = useState<boolean | null>(null);
  const [msConnected, setMsConnected] = useState<boolean | null>(null);
  const [outreachConnected, setOutreachConnected] = useState<boolean | null>(
    null
  );
  const [dashSummary, setDashSummary] = useState<{
    overdueTasks: number | null;
    dueOutreach: number | null;
  } | null>(null);

  useEffect(() => {
    checkConnections();
  }, []);

  async function checkConnections() {
    try {
      const [sfRes, msRes, orRes] = await Promise.all([
        fetch("/api/salesforce/status"),
        fetch("/api/microsoft/status"),
        fetch("/api/outreach/status"),
      ]);
      if (sfRes.ok) {
        const sfData = await sfRes.json();
        setSfConnected(sfData.connected);
      }
      if (msRes.ok) {
        const msData = await msRes.json();
        setMsConnected(msData.connected);
      }
      if (orRes.ok) {
        const orData = await orRes.json();
        setOutreachConnected(orData.connected);
      }
    } catch {
      setSfConnected(false);
      setMsConnected(false);
      setOutreachConnected(false);
    }

    // Load dashboard summary (non-blocking)
    try {
      const sumRes = await fetch("/api/dashboard/summary");
      if (sumRes.ok) {
        const sumData = await sumRes.json();
        setDashSummary(sumData);
      }
    } catch {
      // Non-fatal
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-8 py-4 shadow-lg"
        style={{ background: "var(--navy)" }}
      >
        <div className="flex items-center gap-3">
          <img
            src="/valstone-logo.png"
            alt="Valstone"
            className="h-8 w-auto rounded"
          />
          <span className="text-sm font-normal text-gray-300">
            Valstone Platform
          </span>
        </div>

        <button
          onClick={handleLogout}
          className="text-gray-300 hover:text-white text-sm"
        >
          Sign out
        </button>
      </header>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-8 py-16">
        <div className="max-w-7xl w-full">
          {/* Morning dashboard summary */}
          {dashSummary && (
            <div className="flex flex-wrap justify-center gap-4 mb-8">
              {dashSummary.overdueTasks != null && dashSummary.overdueTasks > 0 && (
                <a
                  href="/tasks"
                  className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-full px-4 py-2 hover:bg-red-100 transition-colors"
                >
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-sm font-medium text-red-700">
                    {dashSummary.overdueTasks} overdue task{dashSummary.overdueTasks !== 1 ? "s" : ""}
                  </span>
                </a>
              )}
              {dashSummary.dueOutreach != null && dashSummary.dueOutreach > 0 && (
                <a
                  href="/outreach"
                  className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-full px-4 py-2 hover:bg-orange-100 transition-colors"
                >
                  <span className="w-2 h-2 rounded-full bg-brand-orange" />
                  <span className="text-sm font-medium text-amber-700">
                    {dashSummary.dueOutreach} account{dashSummary.dueOutreach !== 1 ? "s" : ""} due for outreach
                  </span>
                </a>
              )}
              {dashSummary.overdueTasks === 0 && dashSummary.dueOutreach === 0 && (
                <span className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-full px-4 py-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-sm font-medium text-green-700">
                    All clear — nothing overdue
                  </span>
                </span>
              )}
            </div>
          )}

          <h1 className="text-2xl font-semibold text-navy text-center mb-2">
            What would you like to do?
          </h1>
          <p className="text-sm text-gray-400 text-center mb-10">
            Choose a tool to get started
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {/* ── Task Manager Card ────────────────────────────────────── */}
            <a
              href="/tasks"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-brand-orange transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-brand-orange transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Task Manager
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Manage your open Salesforce tasks — view by week, delete,
                reschedule, or delay in bulk.
              </p>

              {/* Connection status */}
              {sfConnected === true ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Salesforce connected
                </span>
              ) : sfConnected === false ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  Salesforce not connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  Checking...
                </span>
              )}
            </a>

            {/* ── Outreach Queue Card ──────────────────────────────────── */}
            <a
              href="/outreach"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-brand-orange transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-brand-orange transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Outreach Queue
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Surface accounts due for a 2nd back-to-back hit or a
                post-cooldown restart, and push the next contact to SF +
                Outreach.
              </p>

              {/* Connection statuses */}
              <div className="flex flex-col items-center gap-1.5">
                {sfConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Salesforce connected
                  </span>
                ) : sfConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                    Salesforce not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}

                {outreachConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Outreach connected
                  </span>
                ) : outreachConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-brand-orange bg-orange-50 border border-orange-200 rounded-full px-3 py-1">
                    Outreach not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}
              </div>
            </a>

            {/* ── Call Logger Card ─────────────────────────────────────── */}
            <a
              href="/calls"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-blue-400 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-blue-500 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Call Logger
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Log calls from your Outlook calendar to Salesforce — match
                meetings to accounts automatically.
              </p>

              {/* Connection statuses */}
              <div className="flex flex-col items-center gap-1.5">
                {sfConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Salesforce connected
                  </span>
                ) : sfConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                    Salesforce not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}

                {msConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Outlook connected
                  </span>
                ) : msConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-3 py-1">
                    Outlook not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}
              </div>
            </a>

            {/* ── Call Prep Card ──────────────────────────────────────── */}
            <a
              href="/prep"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-teal-400 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-teal-500 transition-colors"
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
              <h2 className="text-lg font-semibold text-navy mb-2">
                Call Prep
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Generate AI-powered one-pager briefings for your upcoming
                meetings — download as Word docs.
              </p>

              {/* Connection statuses */}
              <div className="flex flex-col items-center gap-1.5">
                {sfConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Salesforce connected
                  </span>
                ) : sfConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                    Salesforce not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}

                {msConnected === true ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Outlook connected
                  </span>
                ) : msConnected === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-3 py-1">
                    Outlook not connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                    Checking...
                  </span>
                )}
              </div>
            </a>

            {/* ── Account Creator Card ────────────────────────────────── */}
            <a
              href="/accounts"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-green-400 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-green-500 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Account Creator
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Paste a company URL to auto-fill and create a new Salesforce
                account in seconds.
              </p>

              {/* Connection status */}
              {sfConnected === true ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Salesforce connected
                </span>
              ) : sfConnected === false ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  Salesforce not connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  Checking...
                </span>
              )}
            </a>
            {/* ── Sourcing Tool Card ──────────────────────────────────── */}
            <a
              href="/sourcing"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-violet-400 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-violet-500 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Sourcing Tool
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Paste a company URL to research their products, match to a
                portfolio group, and generate personalized outreach.
              </p>
              <span className="inline-flex items-center gap-1.5 text-xs text-violet-600 bg-violet-50 border border-violet-200 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                M&amp;A Research
              </span>
            </a>

            {/* ── Weekly Stats Card ──────────────────────────────────── */}
            <a
              href="/stats"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-purple-500 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-purple-500 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 19V6m0 13l-3-3m3 3l3-3M15 5v13m0-13l-3 3m3-3l3 3"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 3v18h18"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Weekly Stats
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                CDM group dashboard — outreach, calls, F2F, and BRO pipeline
                across this week, last quarter, or YTD.
              </p>

              {sfConnected === true ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Salesforce connected
                </span>
              ) : sfConnected === false ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  Salesforce not connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  Checking...
                </span>
              )}
            </a>

            {/* ── Trip Planner Card ──────────────────────────────────── */}
            <a
              href="/trip"
              className="group block bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-lg hover:border-emerald-400 transition-all p-8 text-center"
            >
              <div className="text-4xl mb-4">
                <svg
                  className="w-12 h-12 mx-auto text-navy group-hover:text-emerald-500 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-navy mb-2">
                Trip Planner
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                Find nearby CDM accounts and discover new targets when
                traveling — ranked by driving distance.
              </p>

              {/* Connection status */}
              {sfConnected === true ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Salesforce connected
                </span>
              ) : sfConnected === false ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  Salesforce not connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  Checking...
                </span>
              )}
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
