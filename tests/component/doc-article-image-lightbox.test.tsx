// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { DocArticle } from "@/components/docs-viewer/doc-article";

/**
 * DocArticle exposes every embedded image as an "expand" control that
 * opens the full-view image modal (the help walkthrough's screenshots are
 * scaled down to the prose column). We mock the theme provider and
 * next-intl so the effects run under jsdom, then assert the contract:
 * a11y affordance on the image, click/keyboard open, modal content and
 * close, and the linked-image + mermaid-mount exclusions.
 */
vi.mock("@/components/theme/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

// Passthrough translator: returns the message key so assertions are stable.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const IMG_HTML =
  '<p>intro</p><img src="/api/help/asset/screenshots/01-landing.png" alt="Public landing page">';

function decoratedImg(container: HTMLElement): HTMLImageElement {
  return container.querySelector<HTMLImageElement>('img[data-lightbox="true"]')!;
}

async function openDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) throw new Error("dialog not open yet");
    return d as HTMLElement;
  });
}

describe("DocArticle image lightbox", () => {
  it("exposes an embedded image as an accessible expand control", async () => {
    const { container } = render(<DocArticle html={IMG_HTML} />);
    await waitFor(() => expect(decoratedImg(container)).not.toBeNull());

    const img = decoratedImg(container);
    expect(img.getAttribute("role")).toBe("button");
    expect(img.getAttribute("tabindex")).toBe("0");
    expect(img.getAttribute("aria-label")).toBe("Public landing page — image.expand");
    expect(img.classList.contains("cursor-zoom-in")).toBe(true);
  });

  it("opens the full-size modal on click and closes on Escape", async () => {
    const { container } = render(<DocArticle html={IMG_HTML} />);
    await waitFor(() => expect(decoratedImg(container)).not.toBeNull());

    fireEvent.click(decoratedImg(container));
    const dialog = await openDialog();

    const modalImg = within(dialog).getByRole("img") as HTMLImageElement;
    expect(modalImg.getAttribute("src")).toContain("/api/help/asset/screenshots/01-landing.png");
    expect(modalImg.getAttribute("alt")).toBe("Public landing page");
    // The alt text doubles as the dialog title.
    expect(dialog.textContent).toContain("Public landing page");

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("opens the modal from the keyboard (Enter)", async () => {
    const { container } = render(<DocArticle html={IMG_HTML} />);
    await waitFor(() => expect(decoratedImg(container)).not.toBeNull());

    fireEvent.keyDown(decoratedImg(container), { key: "Enter" });
    expect(await openDialog()).toBeTruthy();
  });

  it("leaves images wrapped in a link alone", async () => {
    const html = '<a href="/somewhere"><img src="/x.png" alt="linked"></a>';
    const { container } = render(<DocArticle html={html} />);
    // Effects have run once the component is mounted; the image must NOT
    // be decorated (its click has to keep following the link).
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const img = container.querySelector<HTMLImageElement>("img")!;
    expect(img.dataset.lightbox).toBeUndefined();
    expect(img.getAttribute("role")).toBeNull();

    fireEvent.click(img);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("falls back to a generic title when the image has no alt text", async () => {
    const { container } = render(<DocArticle html='<img src="/x.png" alt="">' />);
    await waitFor(() => expect(decoratedImg(container)).not.toBeNull());
    expect(decoratedImg(container).getAttribute("aria-label")).toBe("image.expand");

    fireEvent.click(decoratedImg(container));
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("image.title");
  });
});
