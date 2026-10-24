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
