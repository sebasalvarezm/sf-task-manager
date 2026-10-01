# sf-task-manager review (Oct 1, 2026)

## Pass 2 result

**Fixed:** the critical item, all 20 highs, 25 of 31 mediums and 2 lows, in 42 commits: one per issue, plus 5 small follow-ups that a second review pass caught in my own fixes. After the fixes, a clean install passes typecheck, all 131 tests (115 before) and the production build. npm audit went from 41 to 38, and the critical Next.js one is gone.

**Still open:** M11, M15, M20, M24, M27, M31 and most lows. Each is listed below with ⬜.

**What you need to do:**
1. **Run `supabase/2026-10-review-fixes.sql` once** in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run). It turns on RLS for every table and adds the Triage `sent_at` column. The app keeps working before you run it.
2. **Log in again after the deploy.** The old cookie is no longer accepted (that was C1), so everyone gets signed out once.
3. **Reconnect Salesforce, Outlook and Outreach only if a page asks you to.** The saved connections still work.
4. **Watch for:** Call Logger now skips a call when Salesforce already has the same call type (C1 or RCC) on that account that day. It shows "already in Salesforce, skipped".

**Mail.ReadWrite:** you confirmed IT granted it. Connect and the callback now both ask for the same scopes (H6). If IT ever withdraws it, draft actions say so in plain English instead of breaking (M2). Nothing else needs to change.

**Not verified live (by design, nothing touched your real data):** the Vercel environment variables (`INNGEST_SIGNING_KEY` should be set and `INNGEST_DEV` should not be), the current RLS state in your project, and real Salesforce and Graph responses. Salesforce and Graph behaviour was tested with mocks. Layout was re-checked with fake data at 375, 1024 and 1440px.

**Remaining npm advisories (38):** they all come from inside inngest, docx and exceljs (gRPC, protobuf, nanoid, brace-expansion), not from code we call with untrusted input. `npm audit fix` couldn't run here because the package registry refused one download. It's safe to try on a future dependency update.

---

Fresh-eyes review of `main` at `0245ae5`. Everything was built and tested in a separate cloud copy. Nothing was sent to Salesforce, Outlook, Supabase or Inngest. Layout was checked with fake data at 375, 1024 and 1440px.

Format: **file:line** | what's wrong | how to reproduce.

## Build health (summary)

- Clean install works. Typecheck passes with 0 errors. All 115 tests pass. Production build passes.
- Build warnings: `middleware.ts` uses a file name Next.js 16 has deprecated (it wants `proxy.ts`), and browser-compatibility data is 8 months old. Both are harmless.
- There is no lint step. No ESLint config and no `lint` script, so lint can't run. Noted only; I didn't add one.
- `npm audit`: 41 known vulnerabilities, 1 of them critical (Next.js 16.1.6). See H3.
- Git history (212 commits, all branches) has no keys or tokens. No server secrets end up in the browser bundle. No open redirects.
- The September repair left no damage in the history I can see: no truncated files and no missing imports. The one leftover I suspect is H16 (a route that was never committed).

## Critical

- ✅ FIXED C1 **lib/roles.ts:15, middleware.ts:22** | The login cookie is a fixed word (`authenticated`), and the repo is public. Anyone can set that cookie in a browser and get full admin access: read Salesforce, delete tasks, create Outlook drafts, send email through Triage. | Run `curl -H "Cookie: sf_task_mgr_session=authenticated" https://<app>/api/salesforce/tasks` with no password and it returns your task list.

## High

- ✅ FIXED H1 **app/api/{salesforce,microsoft,outreach}/callback/route.ts** | The OAuth callbacks are public and don't check a `state` value. Anyone who finishes a login with their own account can overwrite the single shared Salesforce, Outlook or Outreach connection, and the app then reads and writes their account instead of yours. | Open the connect URL in a logged-out browser and sign in with any Salesforce or Microsoft account. The "default" credentials row gets replaced.
- ✅ FIXED H2 **lib/salesforce.ts:65,91,153 + app/api/salesforce/actions/route.ts:53** | The task ID goes straight into the Salesforce URL without checking it, so `../Account/<id>` turns "delete task" into "delete any record". | POST `/api/salesforce/actions` with `taskId: "../Account/001..."` and `actionType: "hard_delete"`.
- ✅ FIXED H3 **package.json / package-lock.json** | Next.js 16.1.6 has published critical and high advisories (Server Actions CSRF bypass, request smuggling, DoS). Patched 16.x releases exist. | Run `npm audit --omit=dev`.
- ✅ FIXED H4 **lib/sf-query.ts:35, lib/token-manager.ts:20** | The Salesforce token is refreshed only after 100 minutes. If Salesforce ends the session earlier (org timeout, revoked session), every page shows raw `HTTP 401 [{"errorCode":"INVALID_SESSION_ID"}]` instead of refreshing and retrying. | Revoke the app's session in Salesforce Setup, then load /stats.
- ✅ FIXED H5 **lib/token-manager.ts:57, lib/microsoft.ts:76** | Any failed token refresh deletes the saved Salesforce or Outlook connection, even a brief outage, rate limit or network blip. You then have to reconnect for no reason. | A 503 from the Microsoft token endpoint leaves the next page showing "Outlook not connected".
- ✅ FIXED H6 **lib/microsoft.ts:20 vs app/api/microsoft/callback/route.ts:38** | The code asks Microsoft for **Mail.ReadWrite** (commit 5ac4087, "admin consent is granted"), but the callback still names Mail.Read. If IT has really granted only Mail.Read: Connect shows a "needs admin approval" screen, every 45-minute refresh fails, and that wipes the Outlook connection (see H5). The draft features also say "Reconnect Outlook", which can't fix a missing permission. **Needs your confirmation of what IT actually granted.** | Decode the stored token's `scp` value, or try Connect Outlook.
- ✅ FIXED H7 **app/api/jobs/start/route.ts:55,73 + app/(app)/calls/page.tsx:255,267** | Call Logger can log the same calls twice in Salesforce, in three ways. Nothing blocks a double submit. Cancel doesn't stop the background job. A failed job shows an empty green banner while the entries stay queued, so you press Log again. | Click "Log N calls", Cancel, then Log again. You get duplicate C1/RCC tasks, follow-ups and notes.
- ✅ FIXED H8 **app/(app)/accounts/page.tsx:159-184** | After you reload the page or reopen a run, "Create Account in Salesforce" is clickable again for accounts you already created, which makes a duplicate Account. | Create an account, refresh `/accounts?jobId=X`, and click Create again.
- ✅ FIXED H9 **app/(app)/tasks/page.tsx:207 + app/api/salesforce/actions/route.ts** | A big Apply batch can time out. Every row then says "Network error" even though some actions already ran, and applying again creates duplicate follow-up tasks. There's no time limit set for this route either. | Queue about 30 reschedules on a slow connection and press Apply twice.
- ✅ FIXED H10 **lib/jobs/sourcing-bulk-runner.ts:57 + lib/inngest/functions/sourcing-bulk.ts:85,194** | The E1 sourcing batch matches results to rows by position, but it removes duplicates and caps at 50 first. Any change in count shifts every later row, so a draft lands on the wrong company. | Two E1 rows with the same website, or more than 50 E1s, give later rows another company's draft.
- ✅ FIXED H11 **app/(app)/weekly-outreach/page.tsx:1666-1678** | Industry, Country, City, Tier and Group cells don't refresh when the background job fills them. Tabbing through a cell writes the stale empty value back over the real one. | Start an E1 batch, then tab across the Industry column. The filled-in values get wiped.
- ✅ FIXED H12 **app/api/weekly-outreach/prepare-rce/route.ts:190-345** | Preparing an RCE again leaves the previous Outlook draft behind as a duplicate. This route also does about 7 slow external calls with no time limit, so a timeout shows "Unexpected token <" instead of a message. | Prepare the same RCE twice and you get two drafts in Outlook.
- ✅ FIXED H13 **app/(app)/triage/page.tsx:529 + app/api/triage/send/route.ts** | After you send, Triage still shows an active "Send Reply" button and keeps no sent flag, so a second click sends the email again. (The page isn't in the nav, but it still works.) | Click Send Reply twice.
- ✅ FIXED H14 **lib/inngest/functions/*.ts** | No background job has a failure handler. If Vercel kills a run, the job stays "running" forever. | Run an Accounts enrichment with 5 slow URLs and the job row never finishes.
- ✅ FIXED H15 **supabase/setup.sql** | None of the SQL turns on row-level security, and the Salesforce, Outlook and Outreach tokens are stored in plain text. If RLS is off in your project, anyone holding the Supabase anon key can read the tokens. | Supabase dashboard → Table Editor → `sf_credentials`. It shows "RLS disabled".
- ✅ FIXED H16 **app/(app)/prep/page.tsx:292** | The page calls `/api/prep/library`, which doesn't exist (probably lost or never committed). The "preps you already generated on another device" feature quietly does nothing. | Generate a prep on one laptop and open /prep on another. It isn't there.
- ✅ FIXED H17 **lib/account-match.ts:162 + lib/weekly-outreach.ts:319** | The exact-name match can be missed for short or common names. The lookup takes only the first 200 "contains" matches in alphabetical order, so an exact "ITS" can fall outside that cut-off. | Add "ITS" in Weekly Outreach. You may get suggestions instead of the exact account.
- ✅ FIXED H18 **lib/sf-query.ts:37, lib/salesforce*.ts, lib/microsoft.ts, about 40 API routes** | Salesforce, Graph and Outreach error bodies go straight to the screen as raw JSON. | Delay a task that was deleted in Salesforce and you see `Delay failed: [{"errorCode":"ENTITY_IS_DELETED"...}]`.
- ✅ FIXED H19 **app/(app)/prep/page.tsx:923** @1024px | The meetings table is wider than its box and the box hides the overflow, so the First Call and Generate controls are cut off and can't be reached. | Open /prep at 1024px wide.
- ✅ FIXED H20 **app/(app)/sourcing/page.tsx:1135** @375px | A long domain in the result header pushes the page sideways (about 536px wide). | Open a sourcing result on a phone.

## Medium

- ✅ FIXED M1 **middleware.ts:47** | The logo request redirects to /login, so the Next image optimizer gets the login page instead of the image and the Valstone logo is broken on every page. | Load any page. The logo is broken and `/_next/image` returns 400.
- ✅ FIXED M2 **lib/microsoft.ts:419-598** | The draft actions (create, edit, send, delete) treat any 403 as "Reconnect Outlook". A missing Mail.ReadWrite permission should get its own plain message. `sendOutlookDraft` doesn't map 403 at all. | Prepare an RCE with only Mail.Read granted.
- ✅ FIXED M3 **app/api/weekly-outreach/review-rce/route.ts:113, prepare-rce/route.ts:363** | "MS_NOT_CONNECTED" reaches the user as the raw code, with no reconnect link. | Disconnect Outlook, then Save or Send in the RCE review sheet.
- ✅ FIXED M4 **app/api/weekly-outreach/prepare-rce/route.ts:192** | With Outlook disconnected, Prepare quietly makes a generic "draft_ready" email with no thread and no warning. | Disconnect Outlook and click Prepare.
- ✅ FIXED M5 **app/(app)/weekly-outreach/page.tsx:895,945** | The follow-up preview and send ignore the "reconnect Outlook" code, so no reconnect banner appears. | Open the follow-up sheet when Outlook needs reconsent.
- ✅ FIXED M6 **app/(app)/weekly-outreach/page.tsx:772-790** | Row edits and removals don't catch network errors. An edit looks saved but is lost. | Go offline and change a status.
- ✅ FIXED M7 **app/(app)/weekly-outreach/page.tsx:990** | "Prepare E1 Sourcing Batch" doesn't check that rows were marked "researching", so clicking again starts a duplicate batch. | Make the PATCH fail, then click again.
- ✅ FIXED M8 **app/api/weekly-outreach/route.ts:115, app/api/salesforce/recheck/route.ts:59, app/api/microsoft/calendar/route.ts:80** | "NOT_CONNECTED" shows as the raw code instead of "Connect Salesforce". | Disconnect Salesforce, then add a company in Weekly Outreach.
- ✅ FIXED M9 **app/(app)/{page,tasks,calls,prep,accounts,trip,outreach}.tsx status checks** | If a status check fails, the page shows "Checking connection…" forever. | Make `/api/salesforce/status` return 500.
- ✅ FIXED M10 **app/components/ConnectSalesforce.tsx:16, calls/page.tsx:403, prep/page.tsx:781** | One click disconnects the shared connection, with no confirmation. On Calls and Prep the green "Outlook" pill is itself the disconnect button. | Click the green Outlook pill on /calls.
- ⬜ OPEN M11 **OAuth callbacks** | Connection errors (`sf_error`, `ms_error`) are never shown, and you always land on Home or /calls. | Cancel the Salesforce consent screen. No message appears.
- ✅ FIXED M12 **lib/jobs.ts:99 + app/api/jobs/[id]/route.ts:27** | Cancel only changes the label. The job keeps running and later overwrites "cancelled" with "succeeded". | Cancel a running sourcing job and it ends as succeeded.
- ✅ FIXED M13 **app/api/jobs/start/route.ts:73** | If Inngest rejects the job, the row stays "queued" forever. | A missing Inngest event key leaves a stuck job.
- ✅ FIXED M14 **lib/inngest/functions/sourcing-bulk.ts:192-230** | The final Weekly Outreach writes run outside a step, so they repeat on every retry and ignore errors. | Read the code.
- ⬜ OPEN M15 **lib/inngest/functions/trip-geocode.ts:22, accounts-enrich.ts:25** | All the work runs in one step and can hit the 300-second limit. | Run the first geocode over many accounts.
- ✅ FIXED M16 **app/api/calls/suggest/route.ts:11** | An Anthropic error crashes the route and shows "Unexpected end of JSON input". | Click "Suggest from notes" while Anthropic is rate-limited.
- ✅ FIXED M17 **app/api/salesforce/create-account/route.ts:79** | Salesforce validation errors are shown as raw JSON (covered by the H18 fix). | Create an account with an invalid State.
- ✅ FIXED M18 **app/(app)/outreach/page.tsx:281, 808** | A failed push (expired session, 400) crashes the page with a TypeError. | Let the session expire, then "Send to Outreach Outbox".
- ✅ FIXED M19 **app/(app)/outreach/page.tsx:191** | A timeout shows raw Vercel HTML to the user. | A queue timeout shows the 504 text.
- ⬜ OPEN M20 **app/(app)/stats/page.tsx:377** | Switching the date range fast can show the old range's numbers. | Click two presets quickly.
- ✅ FIXED M21 **app/(app)/prep/page.tsx:664** | Download errors are swallowed and the button just resets. | Make the download fail.
- ✅ FIXED M22 **app/(app)/trip/page.tsx:194,295** | When a scan fails, the button resets with no message. | Make the scan job fail.
- ✅ FIXED M23 **app/api/triage/scan/route.ts:155** | "Scan Now" deletes today's edited drafts before re-inserting. | Edit a draft, then Scan Now.
- ⬜ OPEN M24 **app/api/sourcing/rehook/route.ts:47** | Two "Deep research this hook" clicks in the same batch overwrite each other. | Click it on two companies at once.
- ✅ FIXED M25 **lib/salesforce-calls.ts:73** | Account IDs and dates go into a Salesforce query without escaping (read-only, but malformed input breaks it). | POST odd IDs to `/api/salesforce/check-logged`.
- ✅ FIXED M26 **supabase/app-settings.sql:11** | The comment says setup.sql has this table, but it doesn't, and there's no run order. A fresh database breaks the outreach-quality settings and the Wayback cache. | Build a fresh project from setup.sql only.
- ⬜ OPEN M27 **app/api/dashboard/summary/route.ts:52** | The Home "accounts due" number doesn't match /outreach. | Compare the two.
- ✅ FIXED M28 **app/api/jobs/[id]/route.ts** | Interns can read and cancel any job, including Call Logger and Prep results. | Log in as intern and GET `/api/jobs/<calls job id>`.
- ✅ FIXED M29 Layout @1024 | /tasks header crushes the title, and Disconnect is cut off (app/components/ui/PageHeader.tsx:24). The /weekly-outreach goal panel buttons overlap the progress counter (weekly-outreach/page.tsx:1279). The /calls Meeting Title column squeezes to 10+ lines (CallLoggerTable.tsx:362). | Open the pages at 1024px.
- ✅ FIXED M30 Layout @375 | Long website links overflow the cards on /trip (trip/page.tsx:586). Weekly Outreach card titles truncate to about 14 characters (weekly-outreach/page.tsx:1415). The grid Type column shows "RC" (weekly-outreach/page.tsx:1595). | Open the pages on a phone.
- ⬜ OPEN M31 Speed | /outreach queue, /stats engagement, /recheck (200 accounts) and the Weekly Outreach URL paste (up to 50 lookups one at a time) run many Salesforce or Graph calls back to back with no time limit. They're slow and can time out. | Load /outreach with a large E5 history.

## Low

- ⬜ OPEN L1 **app/(app)/triage** | The page exists but nothing links to it.
- ⬜ OPEN L2 **app/login/page.tsx:20** | A network error leaves Login spinning forever, and a server error says "Incorrect password".
- ⬜ OPEN L3 **app/(app)/tasks/page.tsx:290** | The text says "Connect Salesforce in the top-right", but that button isn't there when you're disconnected.
- ⬜ OPEN L4 **app/api/jobs/route.ts:36** | Pages track only the 20 newest jobs, so older `?jobId=` links open blank or stale (accounts, sourcing, trip).
- ⬜ OPEN L5 **lib/weekly-outreach.ts:470** | Re-pasting an account already in the week wipes its RCE metadata.
- ⬜ OPEN L6 **lib/jobs/calls-log-runner.ts:37** | One failure midway through a call log leaves a partial log (task created, note not).
- ⬜ OPEN L7 **app/api/jobs/start/route.ts:11** | It accepts "task_bulk", but nothing runs that job.
- ✅ FIXED L8 **lib/salesforce-calls.ts:25** | The domain goes into a query without escaping.
- ⬜ OPEN L9 **app/api/triage/route.ts:44** | The API key comparison isn't constant-time.
- ⬜ OPEN L10 Small touch targets on mobile: the Disconnect buttons are 16px tall, and so are "Change" on /prep and "?" on /calls.
- ⬜ OPEN L11 /stats on mobile drops chart labels and the KPI "$45.7M" touches its card edge. Badges wrap inside their pills on /recheck and /sourcing.
- ⬜ OPEN L12 /calls, /prep and /accounts show the page title twice.
- ⬜ OPEN L13 Dead code: `createFollowUpTask`, `resetWaybackOutageState`, unused types in lib/supabase.ts, about 20 unused exports.
- ⬜ OPEN L14 **CLAUDE.md** | Out of date. It describes Scout as a separate Python/Streamlit app, but Scout now lives in lib/scout.ts.
- ⬜ OPEN L15 `middleware.ts` should be renamed `proxy.ts` for Next.js 16 (build warning).
- ✅ FIXED L16 `.gitignore` lists `.vercel` twice.

## Salesforce write paths (all user-triggered, none automatic)

1. `/api/salesforce/actions`: delete task, complete and reschedule (edit and create a task), delay task. From /tasks Apply. Guarded by login, and IDs are now validated (H2).
2. Call Logger background job (`calls_log`): create the completed C1/RCC task, create or move the RCE follow-up, add a note and link it. From /calls "Log". Guarded by login, and now skips calls already logged (H7).
3. `/api/salesforce/create-account`: create an Account. From /accounts. Now checks Salesforce for the website at click time (H8).
4. `/api/salesforce/account-fields`: update Year Established, Employees and Billing Country on an Account. From the Stats BS Meter. Admin only, with the ID validated. This one is fine.

Nothing writes to Salesforce on a schedule or from a page load.
