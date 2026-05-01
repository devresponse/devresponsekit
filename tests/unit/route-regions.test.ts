import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  isLocalizedAuthPath,
  isLocalizedPublicPath,
  isLocalizedSecurePath,
} from "@/config/route-regions";

describe("classifyRoute", () => {
  it("classifies localized /app/* as secure", () => {
    expect(classifyRoute("/en/app")).toBe("secure");
    expect(classifyRoute("/fr/app/dashboard")).toBe("secure");
    expect(classifyRoute("/uk/app/admin/users")).toBe("secure");
    expect(isLocalizedSecurePath("/en/app/dashboard")).toBe(true);
  });

  it("classifies localized auth segments as auth", () => {
    for (const seg of ["sign-in", "sign-up", "forgot-password", "pending-approval", "blocked"]) {
      expect(classifyRoute(`/en/${seg}`)).toBe("auth");
      expect(isLocalizedAuthPath(`/en/${seg}`)).toBe(true);
    }
  });

  it("classifies the locale root and other localized paths as public", () => {
    expect(classifyRoute("/en")).toBe("public");
    expect(classifyRoute("/en/about")).toBe("public");
    expect(classifyRoute("/en/docs")).toBe("public");
    expect(classifyRoute("/en/logged-out")).toBe("public");
    expect(isLocalizedPublicPath("/en")).toBe(true);
  });

  it("treats unknown locales as public so the proxy never accidentally guards them", () => {
    expect(classifyRoute("/zz/app/dashboard")).toBe("public");
    expect(classifyRoute("/")).toBe("public");
    expect(classifyRoute("")).toBe("public");
  });

  it("does not treat /app at the URL root (no locale) as secure", () => {
    expect(classifyRoute("/app/dashboard")).toBe("public");
    expect(isLocalizedSecurePath("/app/dashboard")).toBe(false);
  });
});
