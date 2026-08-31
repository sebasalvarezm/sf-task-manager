import type { ReactNode } from "react";
import { MobileShell } from "@/app/components/shell/MobileShell";
import { RoleProvider } from "@/app/components/RoleContext";
import { JobsProvider } from "@/app/hooks/useJobs";
import { getRole } from "@/lib/auth";

export default async function AppShell({ children }: { children: ReactNode }) {
  // Middleware guarantees a session here; default to "intern" (least access)
  // if the cookie somehow can't be read.
  const role = (await getRole()) ?? "intern";

  return (
    <RoleProvider role={role}>
      {/* One poll of /api/jobs for the whole app. Every useJobs() caller reads
          this shared copy — previously each ran its own timer, so six pages
          polled the same endpoint twice at once. */}
      <JobsProvider>
        <MobileShell>{children}</MobileShell>
      </JobsProvider>
    </RoleProvider>
  );
}
