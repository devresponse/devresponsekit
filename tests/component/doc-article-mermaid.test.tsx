// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocArticle } from "@/app/[locale]/(secure)/app/docs/_components/doc-article";

/**
 * DocArticle lazily renders `.mermaid` mounts with Mermaid. We mock the
 * (heavy, browser-only) library and next-themes so the effect runs under
 * jsdom and we can assert the contract: Mermaid is imported only when a
 * mount exists, each mount is replaced with the rendered SVG, and a render
 * failure falls back to the raw source.
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

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

describe("DocArticle mermaid rendering", () => {
  beforeEach(() => {
    renderMock.mockClear();
    initializeMock.mockClear();
  });

  it("renders a mermaid mount into SVG", async () => {
    const html = '<div class="mermaid not-prose">erDiagram\n  A ||--o{ B : has</div>';
    const { container } = render(<DocArticle html={html} />);

    await waitFor(() => {
      const mount = container.querySelector<HTMLElement>(".mermaid");
      expect(mount?.dataset.rendered).toBe("true");
    });

    const mount = container.querySelector<HTMLElement>(".mermaid")!;
    expect(mount.querySelector('[data-testid="diagram"]')).not.toBeNull();
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "default" }),
    );
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("does not load mermaid when there is no diagram", async () => {
    render(<DocArticle html="<p>Just prose, no diagram.</p>" />);
    // Give any (unexpected) async effect a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("falls back to the raw source when rendering throws", async () => {
    renderMock.mockRejectedValueOnce(new Error("bad diagram"));
    const html = '<div class="mermaid not-prose">erDiagram broken</div>';
    const { container } = render(<DocArticle html={html} />);

    await waitFor(() => {
      const mount = container.querySelector<HTMLElement>(".mermaid");
      expect(mount?.dataset.rendered).toBe("error");
    });
    expect(container.querySelector(".mermaid")!.textContent).toContain("erDiagram broken");
  });
});
