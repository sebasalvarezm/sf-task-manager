import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { sourcingJob } from "@/lib/inngest/functions/sourcing";
import { sourcingBulkJob } from "@/lib/inngest/functions/sourcing-bulk";
import { tripSearchJob } from "@/lib/inngest/functions/trip-search";
import { tripGeocodeJob } from "@/lib/inngest/functions/trip-geocode";
import { callsLogJob } from "@/lib/inngest/functions/calls-log";
import { prepJob } from "@/lib/inngest/functions/prep";
import { accountsEnrichJob } from "@/lib/inngest/functions/accounts-enrich";
import { granolaSyncJob } from "@/lib/inngest/functions/granola-sync";
import { outreachScreenJob } from "@/lib/inngest/functions/outreach-screen";
import { outcomesBuildJob } from "@/lib/inngest/functions/outcomes-build";
import { e1PrepareJob } from "@/lib/inngest/functions/e1-prepare";
import { e1ScheduleJob } from "@/lib/inngest/functions/e1-schedule";
import { e1FillStepJob } from "@/lib/inngest/functions/e1-fill-step";
import { discoveryWeeklyJob, discoveryPreviewJob } from "@/lib/inngest/functions/discovery-weekly";
import { auditWeeklyJob } from "@/lib/inngest/functions/audit-weekly";
import { scheduledActionsJob } from "@/lib/inngest/functions/scheduled-actions";
import { contactNotesJob } from "@/lib/inngest/functions/contact-notes";
import { replyIndexJob } from "@/lib/inngest/functions/reply-index";
import { draftLearningJob } from "@/lib/inngest/functions/draft-learning";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    sourcingJob,
    sourcingBulkJob,
    tripSearchJob,
    tripGeocodeJob,
    callsLogJob,
    prepJob,
    accountsEnrichJob,
    granolaSyncJob,
    outreachScreenJob,
    outcomesBuildJob,
    e1PrepareJob,
    e1ScheduleJob,
    e1FillStepJob,
    discoveryWeeklyJob,
    discoveryPreviewJob,
    auditWeeklyJob,
    scheduledActionsJob,
    contactNotesJob,
    replyIndexJob,
    draftLearningJob,
  ],
});
