import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKMARKS,
  DOCS_SECTIONS,
  browserManifest,
  normalizeBrowserUrl,
} from "./index.js";

describe("BrowserApplication", () => {
  it("normalizes empty or start URLs to sevyn://start", () => {
    expect(normalizeBrowserUrl("")).toBe("sevyn://start");
    expect(normalizeBrowserUrl("   ")).toBe("sevyn://start");
    expect(normalizeBrowserUrl("sevyn://start")).toBe("sevyn://start");
    expect(normalizeBrowserUrl("about:blank")).toBe("sevyn://start");
  });

  it("preserves explicit http and https protocols", () => {
    expect(normalizeBrowserUrl("https://duckduckgo.com")).toBe("https://duckduckgo.com");
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("sevyn://docs")).toBe("sevyn://docs");
  });

  it("prepends https to domain names without protocol", () => {
    expect(normalizeBrowserUrl("duckduckgo.com")).toBe("https://duckduckgo.com");
    expect(normalizeBrowserUrl("github.com/sevynos")).toBe("https://github.com/sevynos");
  });

  it("converts general search queries to search engine URLs", () => {
    expect(normalizeBrowserUrl("react native for linux")).toBe(
      "https://duckduckgo.com/?q=react%20native%20for%20linux",
    );
    expect(normalizeBrowserUrl("sevynos operating system")).toBe(
      "https://duckduckgo.com/?q=sevynos%20operating%20system",
    );
  });

  it("exports a valid SevynApplicationManifest", () => {
    expect(browserManifest.id).toBe("org.sevynos.browser");
    expect(browserManifest.name).toBe("Web Browser");
    expect(browserManifest.runtime).toBe("react-native");
  });

  it("defines comprehensive in-app documentation sections for sevyn://docs", () => {
    expect(DOCS_SECTIONS.length).toBeGreaterThanOrEqual(4);
    const titles = DOCS_SECTIONS.map((section) => section.title);
    expect(titles.some((t) => t.includes("Architecture"))).toBe(true);
    expect(titles.some((t) => t.includes("Genesis Compositor"))).toBe(true);
    expect(titles.some((t) => t.includes("React Native"))).toBe(true);
    expect(titles.some((t) => t.includes("Chromium CDP"))).toBe(true);
  });

  it("includes sevyn://docs in default bookmarks", () => {
    const docsBookmark = DEFAULT_BOOKMARKS.find((b) => b.url === "sevyn://docs");
    expect(docsBookmark).toBeDefined();
    expect(docsBookmark?.title).toBe("Sevyn Docs");
  });
});
