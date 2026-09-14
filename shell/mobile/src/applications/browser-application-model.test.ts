import { describe, expect, it } from "vitest";

import {
  BROWSER_HOME_ADDRESS,
  createArticleDestination,
  createHomeDestination,
  moveBrowserHistory,
  parseBrowserInput,
  pushBrowserHistory,
  type BrowserHistoryState,
} from "./browser-application-model";

describe("native browser navigation", () => {
  it("routes an empty address to the native start page", () => {
    expect(parseBrowserInput("   ")).toEqual({
      kind: "home",
      address: BROWSER_HOME_ADDRESS,
    });
  });

  it("turns ordinary text into an encoded native search", () => {
    expect(parseBrowserInput("  react   native  ")).toEqual({
      kind: "search",
      address: "sevyn://search/react%20native",
      query: "react native",
    });
  });

  it("recognizes direct and Wikipedia article addresses", () => {
    expect(parseBrowserInput("wiki:Ada Lovelace")).toMatchObject({
      kind: "article",
      key: "Ada_Lovelace",
      title: "Ada Lovelace",
    });
    expect(parseBrowserInput("https://en.wikipedia.org/wiki/React_Native")).toMatchObject(
      {
        kind: "article",
        key: "React_Native",
        title: "React Native",
      },
    );
  });

  it("normalizes a public host while refusing executable URL schemes", () => {
    expect(parseBrowserInput("sevynos.org/about")).toEqual({
      kind: "external",
      address: "https://sevynos.org/about",
      url: "https://sevynos.org/about",
    });
    expect(parseBrowserInput("javascript:alert(1)")).toMatchObject({
      kind: "search",
      query: "javascript:alert(1)",
    });
  });

  it("drops forward history after a new navigation", () => {
    let history: BrowserHistoryState = { entries: [createHomeDestination()], index: 0 };
    history = pushBrowserHistory(history, createArticleDestination("Earth"));
    history = pushBrowserHistory(history, createArticleDestination("Moon"));
    history = moveBrowserHistory(history, -1);
    history = pushBrowserHistory(history, createArticleDestination("Sun"));

    expect(history.entries.map((entry) => entry.address)).toEqual([
      "sevyn://home",
      "sevyn://read/Earth",
      "sevyn://read/Sun",
    ]);
    expect(history.index).toBe(2);
  });
});
