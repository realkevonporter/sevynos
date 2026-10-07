import { describe, expect, it } from "vitest";
import { compareOsVersions, isUpdateAvailable, parseOsVersion } from "./version.js";

describe("parseOsVersion", () => {
  it("parses plain and nightly versions", () => {
    expect(parseOsVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseOsVersion("1.2.3-nightly.20261007")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      nightly: "20261007",
    });
    expect(parseOsVersion("0.1.0-nightly.20261007.abc1234")).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      nightly: "20261007.abc1234",
    });
  });

  it("rejects malformed versions", () => {
    for (const bad of ["", "1.2", "v1.2.3", "1.2.3-beta", "1.2.3-nightly", "a.b.c"])
      expect(() => parseOsVersion(bad)).toThrow();
  });
});

describe("compareOsVersions", () => {
  it("orders numeric versions", () => {
    expect(compareOsVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareOsVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareOsVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareOsVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareOsVersions("1.0.0", "0.9.9")).toBe(1);
  });

  it("sorts a nightly newer than the bare release with the same base", () => {
    expect(compareOsVersions("0.1.0", "0.1.0-nightly.20261007")).toBe(-1);
    expect(compareOsVersions("0.1.0-nightly.20261007", "0.1.0")).toBe(1);
  });

  it("orders nightlies by their stamp", () => {
    expect(compareOsVersions("0.1.0-nightly.20261007", "0.1.0-nightly.20261008")).toBe(
      -1,
    );
    expect(compareOsVersions("0.1.0-nightly.20261008", "0.1.0-nightly.20261007")).toBe(1);
    expect(compareOsVersions("0.1.0-nightly.20261007", "0.1.0-nightly.20261007")).toBe(0);
  });

  it("lets a newer stable base beat an older nightly", () => {
    expect(compareOsVersions("0.1.0-nightly.20261007", "0.2.0")).toBe(-1);
    expect(compareOsVersions("0.2.0", "0.1.0-nightly.20261007")).toBe(1);
  });

  it("drives isUpdateAvailable", () => {
    expect(isUpdateAvailable("0.1.0", "0.1.0-nightly.20261007")).toBe(true);
    expect(isUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isUpdateAvailable("0.2.0", "0.1.0-nightly.20261007")).toBe(false);
  });
});
