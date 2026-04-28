import { cn } from "@/lib/cn";
import type { ShellGridContainerProps } from "./shell-types";

/**
 * ShellGridContainer
 *
 * Holy Grail CSS Grid container. Server-compatible. The parent decides
 * which regions are visible via explicit props; this component only
 * arranges them. No local state, no client-only APIs.
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
      {header ? (
        <header className="sh-header" role="banner">
          {header}
        </header>
      ) : null}

      {hasLeft ? (
        <aside className="sh-left" aria-label="Primary navigation" id="navigation">
          {left}
        </aside>
      ) : null}

      <main id={mainId} className={cn("sh-main", mainClassName)} tabIndex={-1}>
        {children}
      </main>

      {hasRight ? (
        <aside className="sh-right" aria-label="Inspector">
          {right}
        </aside>
      ) : null}

      {hasFooter ? (
        <footer className="sh-footer" role="contentinfo">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
