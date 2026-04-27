import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { sourcingJob } from "@/lib/inngest/functions/sourcing";
import { tripSearchJob } from "@/lib/inngest/functions/trip-search";
import { tripGeocodeJob } from "@/lib/inngest/functions/trip-geocode";
import { callsLogJob } from "@/lib/inngest/functions/calls-log";
import { prepJob } from "@/lib/inngest/functions/prep";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    sourcingJob,
    tripSearchJob,
    tripGeocodeJob,
    callsLogJob,
    prepJob,
  ],
});
