// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, useTheme } from "@/components/theme/theme-provider";
import { ThemeScript } from "@/components/theme/theme-script";

/**
 * Tests for the in-house theme provider that replaced `next-themes` (React 19
 * warns about inline `<script>`s created on the client; the anti-flash script
 * is now SERVER-rendered by {@link ThemeScript}, and this provider renders no
 * script — only the runtime context).
 */
function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function Consumer() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme ?? "—"}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
    </div>
  );
}

describe("ThemeScript", () => {
  it("renders a nonce-carrying inline anti-flash script", () => {
    const { container } = render(<ThemeScript nonce="n0nce-abc" />);
    const script = container.querySelector("script");
    expect(script).not.toBeNull();
    expect(script).toHaveAttribute("nonce", "n0nce-abc");
    // The init logic reads the stored "theme", falls back to the OS preference,
    // and stamps the class + color-scheme onto <html>.
    const code = script!.innerHTML;
    expect(code).toContain('"theme"');
    expect(code).toContain("matchMedia");
    expect(code).toContain("classList");
    expect(code).toContain("colorScheme");
  });
});

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when useTheme is used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/useTheme must be used within/);
    spy.mockRestore();
  });

  it("resolves 'system' against the OS preference and applies the class", async () => {
    mockMatchMedia(true); // OS prefers dark
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("setTheme persists the choice and applies it", async () => {
    mockMatchMedia(false); // OS prefers light
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "dark" }));
    await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");

    await user.click(screen.getByRole("button", { name: "light" }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("adopts a persisted preference on mount", async () => {
    localStorage.setItem("theme", "dark");
    mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
