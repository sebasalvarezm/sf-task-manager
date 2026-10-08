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
import { sourcingRehookJob } from "@/lib/inngest/functions/sourcing-rehook";

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
    sourcingRehookJob,
  ],
});
