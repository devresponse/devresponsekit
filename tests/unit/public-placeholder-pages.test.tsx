import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public `/docs` and `/about` (review #225).
 *
 * Both shipped hardcoded English inside a fully localized public shell and
 * neither declared metadata, so a `/uk/about` visitor got an English page
 * with the generic site title. They stay THIN (the substantive copy lives
 * on the landing page and, for docs, behind sign-in) but their text now
 * comes from the `public.*` namespace in all eight locales.
 *
 * They also stop opening their own `<main>`: the `(public)` layout renders
 * the document's single main landmark, so a page-level one nested two
 * mains (review #104).
 */
const getTranslations = vi.fn();
vi.mock("next-intl/server", () => ({
  getTranslations: (...a: unknown[]) => getTranslations(...a),
}));

beforeEach(() => {
  getTranslations.mockReset();
  getTranslations.mockImplementation(({ namespace }: { namespace: string }) =>
    Promise.resolve((key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${JSON.stringify(values)})` : `${namespace}.${key}`,
    ),
  );
});

const params = { params: Promise.resolve({ locale: "uk" }) };

describe("public /docs", () => {
  it("renders its copy from the public.docs namespace and no <main>", async () => {
    const { default: DocsPage } = await import("@/app/[locale]/(public)/docs/page");
    const html = renderToStaticMarkup(await DocsPage(params));

    expect(getTranslations).toHaveBeenCalledWith({ locale: "uk", namespace: "public.docs" });
    expect(html).toContain("public.docs.title");
    expect(html).toContain("public.docs.body");
    // Review #104: the layout owns the single main landmark.
    expect(html).not.toContain("<main");
  });

  it("declares localized metadata", async () => {
    const { generateMetadata } = await import("@/app/[locale]/(public)/docs/page");
    await expect(generateMetadata(params)).resolves.toMatchObject({
      title: "public.docs.title",
      description: "public.docs.body",
    });
  });
});

describe("public /about", () => {
  it("renders its copy from the public.about namespace and no <main>", async () => {
    const { default: AboutPage } = await import("@/app/[locale]/(public)/about/page");
    const html = renderToStaticMarkup(await AboutPage(params));

    expect(getTranslations).toHaveBeenCalledWith({ locale: "uk", namespace: "public.about" });
    // The body interpolates the brand name; the heading stays the brand
    // itself (a proper noun, not translated).
    expect(html).toContain("public.about.body");
    expect(html).toContain("brand");
    expect(html).not.toContain("<main");
  });

  it("declares localized metadata", async () => {
    const { generateMetadata } = await import("@/app/[locale]/(public)/about/page");
    const meta = await generateMetadata(params);
    expect(meta.title).toBe("public.about.title");
    expect(String(meta.description)).toContain("public.about.body");
  });
});
