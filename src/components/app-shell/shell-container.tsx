import { ShellDepthProvider } from "./shell-depth-provider";
import { ShellGridContainer } from "./shell-grid-container";
import type { ShellContainerProps } from "./shell-types";

/**
 * ShellContainer
 *
 * Root application shell for public, auth, or secure route layouts.
 * Server-compatible by default. The parent controls region visibility
 * through explicit props so tests and route layouts remain deterministic.
 * The root frame is viewport-bounded; child regions own internal scrolling.
 */
export function ShellContainer({
  branding,
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
}: ShellContainerProps) {
  return (
    <ShellDepthProvider depth={0}>
      <div className={`sh-container ${className ?? ""}`.trim()}>
        {branding}
        <ShellGridContainer
          variant="root"
          depth={0}
          header={header}
          left={left}
          right={right}
          footer={footer}
          leftVisible={leftVisible}
          rightVisible={rightVisible}
          footerVisible={footerVisible}
          mainClassName={mainClassName}
          ariaLabel={ariaLabel}
          mainId={mainId}
          leftId={leftId}
          leftAriaLabel={leftAriaLabel}
        >
          {children}
        </ShellGridContainer>
      </div>
    </ShellDepthProvider>
  );
}
