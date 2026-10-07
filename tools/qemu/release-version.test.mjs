import assert from "node:assert/strict";
import test from "node:test";
import { resolveReleaseInfo } from "./release-version.mjs";

const OPTIONS = {
  packageVersion: "0.1.0",
  buildDate: "20261007",
  shortSha: "abc1234",
};

test("SEVYN_RELEASE_TAG selects the stable channel and strips the leading v", () => {
  const info = resolveReleaseInfo({ SEVYN_RELEASE_TAG: "v1.2.3" }, OPTIONS);
  assert.deepEqual(info, {
    version: "1.2.3",
    channel: "stable",
    releaseTag: "v1.2.3",
  });
});

test("SEVYN_RELEASE_TAG wins over GITHUB_REF_NAME", () => {
  const info = resolveReleaseInfo(
    { SEVYN_RELEASE_TAG: "v2.0.0", GITHUB_REF_NAME: "v1.9.9" },
    OPTIONS,
  );
  assert.equal(info.version, "2.0.0");
  assert.equal(info.channel, "stable");
  assert.equal(info.releaseTag, "v2.0.0");
});

test("GITHUB_REF_NAME is used when it looks like a release tag", () => {
  const info = resolveReleaseInfo({ GITHUB_REF_NAME: "v0.9.0" }, OPTIONS);
  assert.deepEqual(info, {
    version: "0.9.0",
    channel: "stable",
    releaseTag: "v0.9.0",
  });
});

test("a branch-like GITHUB_REF_NAME keeps the nightly format", () => {
  const info = resolveReleaseInfo({ GITHUB_REF_NAME: "main" }, OPTIONS);
  assert.equal(info.version, "0.1.0-nightly.20261007.abc1234");
  assert.equal(info.channel, "nightly");
  assert.equal(info.releaseTag, undefined);
});

test("a malformed tag falls back to GITHUB_REF_NAME, then nightly", () => {
  const fromRef = resolveReleaseInfo(
    { SEVYN_RELEASE_TAG: "not-a-version", GITHUB_REF_NAME: "v1.0.1" },
    OPTIONS,
  );
  assert.equal(fromRef.version, "1.0.1");
  assert.equal(fromRef.channel, "stable");

  const nightly = resolveReleaseInfo(
    { SEVYN_RELEASE_TAG: "not-a-version", GITHUB_REF_NAME: "main" },
    OPTIONS,
  );
  assert.equal(nightly.version, "0.1.0-nightly.20261007.abc1234");
  assert.equal(nightly.channel, "nightly");
});

test("nightly format is unchanged when no tag is present", () => {
  const info = resolveReleaseInfo({}, OPTIONS);
  assert.equal(info.version, "0.1.0-nightly.20261007.abc1234");
  assert.equal(info.channel, "nightly");
  assert.equal(info.releaseTag, undefined);
});

test("nightly falls back to a local sha when none is provided", () => {
  const info = resolveReleaseInfo({}, { packageVersion: "0.1.0", buildDate: "20261007" });
  assert.equal(info.version, "0.1.0-nightly.20261007.local");
});
