"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/roles";

// The role is resolved on the server in app/(app)/layout.tsx and handed down,
// so client components never render a "full menu" flash before it loads.
const RoleContext = createContext<Role>("admin");

export function RoleProvider({
  role,
  children,
}: {
  role: Role;
  children: ReactNode;
}) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): Role {
  return useContext(RoleContext);
}

export function useIsIntern(): boolean {
  return useRole() === "intern";
}
