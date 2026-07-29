import type { ReactNode } from "react";
import { MobileShell } from "@/app/components/shell/MobileShell";
import { RoleProvider } from "@/app/components/RoleContext";
import { getRole } from "@/lib/auth";

export default async function AppShell({ children }: { children: ReactNode }) {
  // Middleware guarantees a session here; default to "intern" (least access)
  // if the cookie somehow can't be read.
  const role = (await getRole()) ?? "intern";

  return (
    <RoleProvider role={role}>
      <MobileShell>{children}</MobileShell>
    </RoleProvider>
  );
}
