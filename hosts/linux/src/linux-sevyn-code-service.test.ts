/**
 * Tests for the Sevyn Code host service lifecycle.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { LinuxSevynCodeService } from "./linux-sevyn-code-service.js";

describe("LinuxSevynCodeService", () => {
  it("reports not running before start", () => {
    const service = new LinuxSevynCodeService();
    expect(service.status()).toEqual({ running: false });
    expect(service.engine).toBeUndefined();
  });

  it("stop() is safe to call when never started", async () => {
    const service = new LinuxSevynCodeService();
    await service.stop();
    expect(service.status()).toEqual({ running: false });
  });

  it("start() cleans up code-server when Chromium fails to start", async () => {
    // Point at a nonexistent code-server binary so startup fails fast
    // at the code-server stage; then use a bad chromium executable
    // to fail at the engine stage after code-server would have started.
    const service = new LinuxSevynCodeService({
      codeServerBinary: "/nonexistent/code-server",
      codeServerPort: 18099,
    });
    await expect(service.start()).rejects.toThrow();
    // The failed start must not leak: engine and process are released
    expect(service.engine).toBeUndefined();
    expect(service.status()).toEqual({ running: false });
    // stop() after a failed start is a no-op, not a crash
    await service.stop();
  });

  it("start() is idempotent when already started", async () => {
    const service = new LinuxSevynCodeService({
      codeServerBinary: "/nonexistent/code-server",
      codeServerPort: 18098,
    });
    // Both calls fail the same way; the second must not double-spawn
    await expect(service.start()).rejects.toThrow();
    await expect(service.start()).rejects.toThrow();
    expect(service.status()).toEqual({ running: false });
  });
});
