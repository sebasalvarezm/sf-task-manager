import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "valstone-platform",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
