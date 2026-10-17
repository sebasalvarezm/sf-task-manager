import { redirect } from "next/navigation";

/** Re-Contact lives inside Outreach now ("Check a list" tab, same rules of engagement). */
export default function RecheckRedirect() {
  redirect("/outreach?tab=check");
}
