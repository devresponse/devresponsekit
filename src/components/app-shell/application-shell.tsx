"use client";

import { ShellGridContainer } from "./shell-grid-container";
import { useShellDepth } from "./shell-depth-provider";
import type { ApplicationShellProps } from "./shell-types";

/**
 * ApplicationShell
 *
 * Nested shell rendered inside `ShellMain`. Reuses `ShellGridContainer`
 * with `variant="nested"` so the CSS variables shrink to nested
 * dimensions. MUST NOT render its own `TopShellBar` — the brand bar
 * lives at root depth only.
 *
 * Why a Client Component? It reads the shell-depth context to compute
 * `depth + 1`. The context boundary is intentional so server pages can
 * still render this component synchronously inside a client tree.
 */
export function ApplicationShell({
  header,
  left,
  right,
  footer,
  children,
  leftVisible = true,
  rightVisible = true,
  footerVisible = true,
  className,
  mainClassName,
  ariaLabel,
  mainId,
}: ApplicationShellProps) {
  const parentDepth = useShellDepth();

  return (
    <ShellGridContainer
      variant="nested"
      depth={parentDepth + 1}
      header={header}
      left={left}
      right={right}
      footer={footer}
      leftVisible={leftVisible}
      rightVisible={rightVisible}
      footerVisible={footerVisible}
      className={className}
      mainClassName={mainClassName}
      ariaLabel={ariaLabel}
      mainId={mainId}
    >
      {children}
    </ShellGridContainer>
  );
}
