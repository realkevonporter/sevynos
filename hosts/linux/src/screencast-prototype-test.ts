/**
 * Screencast prototype test harness.
 *
 * Launches Chromium with push-based CDP screencast enabled, simulates
 * typing/scrolling, and reports FPS + input-to-frame latency.
 *
 * Usage:
 *   npx tsx src/screencast-prototype-test.ts [url] [durationSeconds]
 *
 * Examples:
 *   npx tsx src/screencast-prototype-test.ts https://example.com 30
 *   npx tsx src/screencast-prototype-test.ts http://127.0.0.1:8080 60
 *
 * For the Sevyn Code test: start code-server first (bound to 127.0.0.1),
 * then point this at its URL.
 *
 * Prerequisites:
 *   - Chromium installed (set CHROMIUM_PATH env var if not on PATH)
 *   - For native decode speed: pnpm add sharp (optional, falls back to pure-TS)
 */

import { ChromiumBrowserEngine } from "./chromium-browser-engine.js";

const url = process.argv[2] ?? "https://example.com";
const durationSeconds = Number(process.argv[3] ?? "30");

async function main(): Promise<void> {
  const chromiumPath = process.env["CHROMIUM_PATH"];
  console.log(`Launching Chromium (screencast mode) -> ${url}`);
  console.log(`Test duration: ${String(durationSeconds)}s`);
  if (chromiumPath) console.log(`Chromium path: ${chromiumPath}`);

  const engine = new ChromiumBrowserEngine({
    ...(chromiumPath ? { executable: chromiumPath } : {}),
    screencast: true,
    screencastQuality: 80,
  });

  try {
    await engine.navigate(url);
    await engine.startScreencast();
    console.log("Screencast started. Simulating input...");

    const endAt = Date.now() + durationSeconds * 1000;
    let iteration = 0;

    // Simulate realistic usage: type, scroll, click in a loop
    while (Date.now() < endAt) {
      iteration++;
      // Type some text (exercises input -> frame path)
      await engine.key("type", `hello ${String(iteration)} `);
      // Scroll down and up (exercises frame delivery under motion)
      await engine.scroll(300);
      await new Promise((r) => setTimeout(r, 500));
      await engine.scroll(-300);
      await new Promise((r) => setTimeout(r, 500));

      // Report stats every 5 seconds
      if (iteration % 5 === 0) {
        const stats = engine.screencastStats();
        if (stats) {
          console.log(
            `[${String(iteration)}] fps=${stats.fps.toFixed(1)} ` +
              `frames=${String(stats.frames)} ` +
              `avgLatency=${stats.averageInputLatencyMs?.toFixed(1) ?? "n/a"}ms ` +
              `lastLatency=${stats.lastInputLatencyMs?.toFixed(1) ?? "n/a"}ms`,
          );
        }
      }
    }

    const final = engine.screencastStats();
    console.log("\n=== FINAL RESULTS ===");
    console.log(`Frames delivered: ${String(final?.frames ?? 0)}`);
    console.log(`Average FPS: ${final?.fps.toFixed(1) ?? "n/a"}`);
    console.log(
      `Average input-to-frame latency: ${final?.averageInputLatencyMs?.toFixed(1) ?? "n/a"}ms`,
    );
    console.log(
      `Last input-to-frame latency: ${final?.lastInputLatencyMs?.toFixed(1) ?? "n/a"}ms`,
    );
    console.log("\nTargets: >=15 FPS, <150ms input latency");

    const fpsOk = (final?.fps ?? 0) >= 15;
    const latencyOk = (final?.averageInputLatencyMs ?? Infinity) < 150;
    console.log(
      `\nVerdict: ${fpsOk && latencyOk ? "PASS" : "FAIL"} ` +
        `(fps ${fpsOk ? "ok" : "MISS"}, latency ${latencyOk ? "ok" : "MISS"})`,
    );
  } finally {
    await engine.stopScreencast().catch(() => undefined);
    await engine.close();
  }
}

main().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exit(1);
});
