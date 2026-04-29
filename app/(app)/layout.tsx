import type { ReactNode } from "react";
import { MobileShell } from "@/app/components/shell/MobileShell";

export default function AppShell({ children }: { children: ReactNode }) {
  return <MobileShell>{children}</MobileShell>;
}
