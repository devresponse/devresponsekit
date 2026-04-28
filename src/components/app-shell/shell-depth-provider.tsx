"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

interface ShellDepthValue {
  depth: number;
}

const ShellDepthContext = createContext<ShellDepthValue>({ depth: 0 });

/**
 * Provides the current shell depth so nested ApplicationShells can size
 * their headers/footers correctly without prop drilling.
 *
 * Why a Client Component? React Context only crosses Server/Client
 * boundaries on the Client side. The depth value is stable per render
 * tree so re-renders are cheap.
 */
export function ShellDepthProvider({
  children,
  depth = 0,
}: {
  children: ReactNode;
  depth?: number;
}) {
  const value = useMemo(() => ({ depth }), [depth]);
  return <ShellDepthContext.Provider value={value}>{children}</ShellDepthContext.Provider>;
}

export function useShellDepth(): number {
  return useContext(ShellDepthContext).depth;
}
