// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocArticle } from "@/components/docs-viewer/doc-article";

/**
 * DocArticle lazily renders `.mermaid` mounts with Mermaid and makes each
 * rendered diagram a clickable control that opens the full-view modal. We
 * mock the (heavy, browser-only) library, the theme provider, and next-intl so
 * the effects run under jsdom, then assert the contract: render → SVG,
 * skip when absent, fall back on error, a11y affordance, and open-modal.
 */
const renderMock = vi.fn(async (_id: string, src: string) => ({
  svg: `<svg data-testid="diagram">${src}</svg>`,
}));
const initializeMock = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (id: string, src: string) => renderMock(id, src),
  },
}));

vi.mock("@/components/theme/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

// Passthrough translator: returns the message key so assertions are stable.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const MERMAID_HTML = '<div class="mermaid not-prose">erDiagram\n  A ||--o{ B : has</div>';

describe("DocArticle mermaid rendering", () => {
  beforeEach(() => {
    renderMock.mockClear();
    initializeMock.mockClear();
  });

  it("renders a mermaid mount into SVG", async () => {
    const { container } = render(<DocArticle html={MERMAID_HTML} />);

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("true");
    });

    const mount = container.querySelector<HTMLElement>(".mermaid")!;
    expect(mount.querySelector('[data-testid="diagram"]')).not.toBeNull();
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "default" }),
    );
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes the rendered SVG but keeps Mermaid's output, incl. foreignObject labels", async () => {
    // Mermaid renders with securityLevel "strict", but DocArticle still runs the
    // SVG through DOMPurify before innerHTML (defense in depth + the CodeQL
    // js/xss-through-dom barrier). The sanitizer must NOT blank diagram text:
    // Mermaid puts node/edge labels in <foreignObject> HTML, so the config has to
    // keep that while still stripping scripts/handlers.
    renderMock.mockResolvedValueOnce({
      svg:
        '<svg data-testid="diagram">' +
        "<style>.node{fill:red}</style>" +
        '<defs><marker id="arrow"><path d="M0 0"></path></marker></defs>' +
        '<g class="node"><rect width="10" height="10"></rect>' +
        // Mermaid renders labels as HTML inside <foreignObject> (even in strict mode).
        '<foreignObject width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml">' +
        '<span class="nodeLabel"><p>Browser</p></span></div></foreignObject>' +
        "</g>" +
        "<script>globalThis.__xss = true</script>" +
        '<g onclick="globalThis.__xss = true"><path d="M1 1"></path></g>' +
        "</svg>",
    });

    const { container } = render(<DocArticle html={MERMAID_HTML} />);
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("true");
    });
    const mount = container.querySelector<HTMLElement>(".mermaid")!;

    // Mermaid's SVG vocabulary survives the sanitizer...
    expect(mount.querySelector('[data-testid="diagram"]')).not.toBeNull();
    expect(mount.querySelector("style")?.textContent).toContain("fill:red");
    expect(mount.querySelector("marker")).not.toBeNull();
    expect(mount.querySelector("rect")).not.toBeNull();
    // ...including the HTML node labels Mermaid renders inside <foreignObject>
    // (the regression that previously blanked every diagram label).
    expect(mount.querySelector("foreignObject")).not.toBeNull();
    expect(mount.textContent).toContain("Browser");
    // ...but the injected <script> and inline handler are stripped.
    expect(mount.querySelector("script")).toBeNull();
    expect(mount.innerHTML.toLowerCase()).not.toContain("onclick");
    expect(mount.innerHTML).not.toContain("__xss");
  });

  it("keeps every label of a REAL Mermaid v11 flowchart through DOMPurify (review #214)", async () => {
    // Verbatim-shaped capture of Mermaid v11's output for
    // `flowchart LR; A[Browser] --> B[Server]` — the structure that actually
    // ships, not a hand-simplified stand-in. Mermaid nests each node label in
    // `<foreignObject><div xmlns=…><span class="nodeLabel"><p>…`, so any
    // sanitize profile that treats the subtree as SVG (e.g. USE_PROFILES:
    // {svg:true}) silently blanks EVERY label while the diagram still "renders".
    // This test is the tripwire for that regression; it is here (and not in the
    // pipeline suite) because the DOMPurify pass is client-side.
    renderMock.mockResolvedValueOnce({
      svg:
        '<svg aria-roledescription="flowchart-v2" role="graphics-document document" ' +
        'viewBox="0 0 218 54" style="max-width: 218px;" xmlns="http://www.w3.org/2000/svg" ' +
        'width="100%" id="mmd-0-30" data-testid="diagram">' +
        "<style>#mmd-0-30{font-family:&quot;trebuchet ms&quot;,verdana,arial,sans-serif;}</style>" +
        '<g><marker orient="auto" markerHeight="8" markerWidth="8" markerUnits="userSpaceOnUse" ' +
        'refY="5" refX="5" viewBox="0 0 10 10" class="marker flowchart-v2" ' +
        'id="mmd-0-30_flowchart-v2-pointEnd">' +
        '<path stroke-width="1" stroke="none" d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath">' +
        "</path></marker>" +
        '<g class="root"><g class="edgePaths">' +
        '<path marker-end="url(#mmd-0-30_flowchart-v2-pointEnd)" ' +
        'class="edge-thickness-normal edge-pattern-solid flowchart-link" id="L_A_B_0" ' +
        'd="M70.5,27L110,27L149.5,27"></path></g>' +
        '<g class="edgeLabels"><g class="edgeLabel">' +
        '<foreignObject height="0" width="0">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" class="labelBkg" ' +
        'style="display: table-cell; white-space: nowrap; text-align: center;">' +
        '<span class="edgeLabel"></span></div></foreignObject></g></g>' +
        '<g class="nodes">' +
        '<g transform="translate(35.25, 27)" id="flowchart-A-0" class="node default">' +
        '<rect height="34" width="70.5" y="-17" x="-35.25" class="basic label-container"></rect>' +
        '<g transform="translate(-27.75, -9.5)" class="label">' +
        '<foreignObject height="19" width="55.5">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;">' +
        '<span class="nodeLabel"><p>Browser</p></span></div></foreignObject></g></g>' +
        '<g transform="translate(180.75, 27)" id="flowchart-B-1" class="node default">' +
        '<rect height="34" width="62.5" y="-17" x="-31.25" class="basic label-container"></rect>' +
        '<g transform="translate(-23.75, -9.5)" class="label">' +
        '<foreignObject height="19" width="47.5">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;">' +
        '<span class="nodeLabel"><p>Server</p></span></div></foreignObject></g></g>' +
        "</g></g></g></svg>",
    });

    const { container } = render(<DocArticle html={MERMAID_HTML} />);
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("true");
    });
    const mount = container.querySelector<HTMLElement>(".mermaid")!;

    expect(mount.querySelectorAll("foreignObject").length).toBe(3);
    expect(mount.querySelectorAll("span.nodeLabel").length).toBe(2);
    expect(mount.textContent).toContain("Browser");
    expect(mount.textContent).toContain("Server");
    // The diagram geometry survives too — this is not an empty <svg>.
    expect(mount.querySelectorAll("rect").length).toBe(2);
    expect(mount.querySelector("marker")).not.toBeNull();
  });

  it("makes the rendered diagram an accessible button", async () => {
    const { container } = render(<DocArticle html={MERMAID_HTML} />);
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("true");
    });
    const mount = container.querySelector<HTMLElement>(".mermaid")!;
    expect(mount.getAttribute("role")).toBe("button");
    expect(mount.getAttribute("tabindex")).toBe("0");
    expect(mount.getAttribute("aria-label")).toBe("diagram.expand");
  });

  it("opens the full-view modal when a diagram is clicked", async () => {
    const { container } = render(<DocArticle html={MERMAID_HTML} />);
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("true");
    });

    fireEvent.click(container.querySelector<HTMLElement>(".mermaid")!);

    const dialog = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("dialog not open yet");
      return d as HTMLElement;
    });
    // The full-view modal shows the same diagram SVG.
    expect(within(dialog).getByTestId("diagram")).toBeTruthy();
  });

  it("does not load mermaid when there is no diagram", async () => {
    render(<DocArticle html="<p>Just prose, no diagram.</p>" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("falls back to the raw source when rendering throws", async () => {
    renderMock.mockRejectedValueOnce(new Error("bad diagram"));
    const { container } = render(
      <DocArticle html='<div class="mermaid not-prose">erDiagram broken</div>' />,
    );

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".mermaid")?.dataset.rendered).toBe("error");
    });
    expect(container.querySelector(".mermaid")!.textContent).toContain("erDiagram broken");
  });
});
