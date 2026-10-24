# Outreach automation: overnight lab log (Oct 24, 2026)

All calls go through /api/lab (admin only, writes limited to test data).
Test prospect: Outreach 61456 (sebasalvarezm@gmail.com). Mailbox 3 (sebastian@valstonecorp.com).
Test sequences: 174 "[TEST] API" (step 1 manual, step 2 auto Reply after 25 min, steps 3-5 auto), 180 "[TEST] API auto" (step 1 auto: subject {{custom1}}, body {{custom120}}{{custom121}}{{custom122}}). Both have no schedule (send any time).

## Findings

1. Prospect custom fields hold up to 32,000 characters (writing 70,000 returns 422 "maximum is 32000 characters"). Stored verbatim, including line breaks, HTML, em dashes and ampersands. Leading and trailing spaces are trimmed.
2. custom2 is already used on almost every prospect (holds a Salesforce record type id, 297 of 300 sampled). custom1 on 11 of 300. custom120-122 unused in a 300-prospect sample.
3. Test contact problem: sebasalvarezm@gmail.com is a Salesforce contact on Exel (a real account). No test email was sent until it was moved.
4. MAJOR: enrolling into [TEST] API (no schedule) made the state active at once, created the step-1 task (10830, type sequence_step_email), AND a mailing 42435 attached to it: state "drafted", mailingType "sequence", linked to sequence, sequenceState, sequenceStep 705 and the task, pre-filled with the step template ("Lunch: Valstone", "(INSERT PRODUCT)"). The old finding "a manual step creates no draft mailing" was only true while the state was pending outside schedule hours.
5. MAJOR: PATCH /mailings/42435 with our own subject and bodyHtml returned 200 and the read-back is exactly our text, still drafted, still linked to the step. Nothing sent.
6. Sequence 174 state 12969 was left enrolled (active, step 1 task 10830, mailing 42435 drafted with LAB TEST C1 text). It sends nothing on its own: a manual step waits for a person or for the app to schedule it.
7. Salesforce naming: "[E1] -", "[E2] -" are the sequence step number. Recent ones are created by Adam D'Cunha's user (the Outreach sync user) with Subject_Type__c E1/E2 and Type Email.
8. Real [E] sequences: 85 enabled, all on schedule 1 (the app cannot read schedule details: missing "schedules" OAuth scope). Step 1 manual, steps 2-5 automatic.
9. Blocked on: the test Gmail is a contact on Exel (real account with live E1-E5 history). Lab update waiting for deploy so the contact can be moved to Amormino. No test email sent until then.

## Code written (not deployed, off by default)
- Setting "Send E1 automatically as step 1" (fillStep, default off) on the Send queue settings.
- lib/e1-sends.ts: findStepMailing (step 1's own mailing via the task), fillStepMailing (write subject and body, read back, schedule; idempotent, never resends).
- lib/inngest/functions/e1-fill-step.ts: per-row job that waits up to ~4 days for Outreach to open step 1, then fills and schedules it.
- e1-schedule job: when fillStep is on, enrols and hands each row to that job.

## After the second deploy (05:05 UTC onward)
10. Moved Salesforce contact "Seb Alvarez" (sebasalvarezm@gmail.com) from Exel to Amormino Inc. (204). Outreach prospect 61456 moved to Outreach account 4159 "Amormino Inc.".
11. DESIGN C, test C1 (seq 174, prospect 61456): PATCHed step 1's own mailing 42435 (subject "Lab test C1: Valstone"), then PATCH state "scheduled" +2 min. Result: delivered 05:10:08, step-1 task 10830 completed at the same second, sequence state moved to step 2 (706), and Outreach immediately created step 2's mailing 42436 "Re: Lab test C1: Valstone", scheduled 25 min later. This is exactly a normal step-1 send.
12. Salesforce, test C1: Outreach's sync (as Adam D'Cunha) logged one task "Lab test C1: Valstone", Type Email, Completed, Outreach_Sequence_Name__c "[TEST] API", Outreach_Sequence_Step__c 1, Outreach_Task__c true. Same fields as a real E1, except no "[E1] -" prefix, no Subject_Type__c, no WhatId.
13. Why: Salesforce flow "Outreach Sequence Automation" (before save, on create) sets Subject = "[E1] - ...", Subject_Type__c = "E1" and WhatId = the contact's account ONLY when Outreach_Sequence_Name__c starts with "[E]" and step = 1 (same for E2-E5, RCE1-3, Fund, IB variants). "[TEST] API" does not start with "[E]", so the flow skipped it. On a real [E] sequence the same email gets the full E1 treatment. Nothing in the app needs to log anything.
14. DESIGN A, test A1 (seq 180, new prospect 63042 sebasalvarezm+a1@gmail.com): with custom122 empty, the enrolment failed at once: state "failed", errorReason "Missing template variable - custom122." Nothing sent. After filling custom122 and re-enrolling: step 1 delivered within seconds with subject from custom1, step 2 "Re: Lab test A1: Valstone" scheduled +25 min.
15. Rendering in design A: HTML in a custom field is inserted as raw HTML (not escaped). Plain text line breaks are NOT converted (would collapse into one paragraph). Outreach appends the mailbox signature itself on automatic steps.
16. Signature in design C: Outreach builds step 1's draft as template + "<div><br/></div><div class=\"outreach-signature\">...". Replacing the whole body drops the signature (C1 went out without one). Test C2 kept that block and replaced only the part above it: body and one signature kept.
17. Test C2 (prospect 63043 +c2, seq 174): scheduled 10 min ahead. It stayed "scheduled" and the task stayed open until the scheduled time (no early send).
18. Cancel (test C3, prospect 63044 +c3): scheduled -> PATCH state "drafted" works (200, stays drafted). Deleting the sequence state then deletes both the step-1 mailing and task (404). Nothing sent.
19. The mailbox signature is also readable from the API (mailboxes.emailSignature), used as a fallback.
20. Test C2 delivered 05:27:05 (scheduled 05:26:44), task complete, state moved to step 2. Sent body contains our text and exactly one signature.
21. Step 2 of C1 ("Re: Lab test C1: Valstone") delivered 05:35:35 and was logged in Salesforce by the Outreach sync. Step 2 of A1 delivered 05:40:35. The API does not expose the reply headers (references is blank), so thread grouping in the inbox needs a look in Gmail.
22. Cleanup: all three test enrolments finished (12969, 12971, 12972) so steps 3-5 never send. Old drafted probe mailings from Oct 21 were already gone. Test prospects 61456, 63042, 63043, 63044 and the moved contact remain (test data only).

## Verdict
Design C works: the app writes into Outreach's own step-1 email and schedules it; Outreach sends it as step 1, completes the task, starts step 2 as a reply, and the Outreach sync logs it in Salesforce with sequence name and step 1, which the "Outreach Sequence Automation" flow turns into "[E1] - ..." / E1 / account for any sequence whose name starts with "[E]". No sequence changes needed.
Design A also works but needs every [E] sequence's step 1 rebuilt as an automatic step, sends at enrolment time (loses the planned send slot), fails on any empty field, and needs the body as HTML. Not recommended.
Not yet proven live: one full run through the app's own job (Send queue -> Inngest -> fill), and the "[E1] -" naming on a real "[E]"-named sequence.

## Code (in the folder, not deployed; off by default)
- lib/e1-sends.ts: fillStep setting; findStepMailing; stepSignature (keeps Outreach's signature block); fillStepMailing (fills, reads back, schedules; never resends).
- lib/inngest/functions/e1-fill-step.ts + registered in app/api/inngest/route.ts.
- lib/inngest/functions/e1-schedule.ts: fillStep branch.
- app/(app)/send/page.tsx: "Send E1 automatically as step 1" setting.
- tests/step-signature.test.ts (3 tests). Full suite: 321 tests pass. Type check clean.
