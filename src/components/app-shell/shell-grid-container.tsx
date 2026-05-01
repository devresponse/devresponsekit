import { cn } from "@/lib/cn";
import { ShellHeader } from "./shell-header";
import { ShellLeft } from "./shell-left";
import { ShellMain } from "./shell-main";
import { ShellRight } from "./shell-right";
import { ShellFooter } from "./shell-footer";
import type { ShellGridContainerProps } from "./shell-types";

/**
 * ShellGridContainer
 *
 * Holy Grail CSS Grid container. Server-compatible. The parent decides
 * which regions are visible via explicit props; this component only
 * arranges them by composing the canonical `ShellHeader`, `ShellLeft`,
 * `ShellMain`, `ShellRight`, and `ShellFooter` region components. No
 * local state, no client-only APIs.
 *
 * Layout assumptions:
 *   - Bounded viewport. The grid uses `min-height: 0` so internal
 *     regions own their scrolling.
 *   - Long content cannot resize columns or rows.
 */
export function ShellGridContainer(props: ShellGridContainerProps) {
  const {
    variant,
    header,
    left,
    right,
    footer,
    children,
    className,
    mainClassName,
    leftMode = "static",
    rightMode = "static",
    footerMode = "visible",
    leftVisible = true,
    rightVisible = true,
    footerVisible = true,
    ariaLabel,
    mainId = "main",
  } = props;

  // Resolve final visibility according to spec §17.5.
  const hasLeft = Boolean(left) && leftMode !== "hidden" && leftVisible;
  const hasRight = Boolean(right) && rightMode !== "hidden" && rightVisible;
  const hasFooter = Boolean(footer) && footerMode !== "hidden" && footerVisible;

  return (
    <div
      className={cn("sh-grid", className)}
      data-variant={variant}
      data-left-hidden={(!hasLeft).toString()}
      data-right-hidden={(!hasRight).toString()}
      data-footer-hidden={(!hasFooter).toString()}
      role="application"
      aria-label={ariaLabel}
    >
      {header ? <ShellHeader>{header}</ShellHeader> : null}
      {hasLeft ? <ShellLeft>{left}</ShellLeft> : null}
      <ShellMain id={mainId} className={mainClassName}>
        {children}
      </ShellMain>
      {hasRight ? <ShellRight>{right}</ShellRight> : null}
      {hasFooter ? <ShellFooter>{footer}</ShellFooter> : null}
    </div>
  );
}
