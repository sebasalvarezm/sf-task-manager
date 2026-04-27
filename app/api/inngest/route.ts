import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { sourcingJob } from "@/lib/inngest/functions/sourcing";

export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [sourcingJob],
});
