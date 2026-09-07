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
 * `layout` picks the region arrangement: `header-first` (default,
 * header spans the full width) or `sidebar-first` (the left region
 * spans the full height and the header sits adjacent to it).
 *
 * Why a Client Component? It reads the shell-depth context to compute
 * `depth + 1`. The context boundary is intentional so server pages can
 * still render this component synchronously inside a client tree.
 *
 * Landmarks (review #105): because `variant="nested"`, the content region
 * renders as a labelled `<section>` (not a second `<main>`) and both the
 * main and left regions get depth-suffixed ids, so the root shell keeps
 * sole ownership of `#main` / `#navigation`. Always pass `ariaLabel` — a
 * `<section>` without an accessible name is not a landmark.
 */
export function ApplicationShell({
  layout,
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
  leftId,
  leftAriaLabel,
}: ApplicationShellProps) {
  const parentDepth = useShellDepth();

  return (
    <ShellGridContainer
      variant="nested"
      depth={parentDepth + 1}
      layout={layout}
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
      leftId={leftId}
      leftAriaLabel={leftAriaLabel}
    >
      {children}
    </ShellGridContainer>
  );
}
