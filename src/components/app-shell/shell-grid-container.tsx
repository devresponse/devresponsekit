import { cn } from "@/lib/utils";
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
 *
 * Landmark ids (review #105): the ROOT shell owns `#main` / `#navigation`,
 * the two `ShellSkipLinks` targets. A nested shell renders inside the root
 * `<main>`, so it derives depth-suffixed ids (`main-1`, `navigation-1`)
 * instead of repeating them — duplicate ids made the skip links jump to
 * whichever element the browser found first.
 */
export function ShellGridContainer(props: ShellGridContainerProps) {
  const {
    variant,
    depth,
    layout = "header-first",
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
    mainId,
    leftId,
    leftAriaLabel,
  } = props;

  // Resolve final visibility according to spec §17.5.
  const hasLeft = Boolean(left) && leftMode !== "hidden" && leftVisible;
  const hasRight = Boolean(right) && rightMode !== "hidden" && rightVisible;
  const hasFooter = Boolean(footer) && footerMode !== "hidden" && footerVisible;

  const isNested = variant === "nested";
  const resolvedMainId = mainId ?? (isNested ? `main-${depth}` : "main");
  const resolvedLeftId = leftId ?? (isNested ? `navigation-${depth}` : "navigation");

  return (
    <div
      className={cn("sh-grid", className)}
      data-variant={variant}
      data-layout={layout}
      data-left-hidden={(!hasLeft).toString()}
      data-right-hidden={(!hasRight).toString()}
      data-footer-hidden={(!hasFooter).toString()}
    >
      {header ? <ShellHeader>{header}</ShellHeader> : null}
      {hasLeft ? (
        <ShellLeft id={resolvedLeftId} ariaLabel={leftAriaLabel}>
          {left}
        </ShellLeft>
      ) : null}
      <ShellMain
        id={resolvedMainId}
        className={mainClassName}
        ariaLabel={ariaLabel}
        nested={isNested}
      >
        {children}
      </ShellMain>
      {hasRight ? <ShellRight>{right}</ShellRight> : null}
      {hasFooter ? <ShellFooter>{footer}</ShellFooter> : null}
    </div>
  );
}
