import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SimulatedWaylandBridgeTransport } from "./simulated-wayland-bridge.js";
import { startWaylandHost } from "./wayland.js";

export interface FocusLatencySummary {
  readonly samples: number;
  readonly minimumMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly maximumRenderRequestsPerClick: number;
  readonly maximumFramesPerClick: number;
}

export async function benchmarkFocusLatency(samples = 20): Promise<FocusLatencySummary> {
  const bridge = new SimulatedWaylandBridgeTransport();
  const markers: string[] = [];
  const starting = startWaylandHost(bridge, { marker: (value) => markers.push(value) });
  bridge.ready(1280, 720, 1);
  const host = await starting;
  await waitFor(() => bridge.frames.length > 0);
  const durations: number[] = [];
  const renderRequests: number[] = [];
  const frames: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const traceId = `benchmark-${String(index + 1)}`;
    const welcome = index % 2 === 0;
    bridge.pointer("down", welcome ? 340 : 668, welcome ? 200 : 550, traceId);
    const prefix = `TS_FOCUS_FRAME_ACKNOWLEDGED traceId=${traceId} `;
    await waitFor(() => markers.some((marker) => marker.startsWith(prefix)));
    const marker = markers.find((candidate) => candidate.startsWith(prefix));
    const match = /totalDurationMs=([\d.]+)/.exec(marker ?? "");
    if (match?.[1] === undefined)
      throw new Error(`Focus trace ${traceId} did not report a total duration.`);
    durations.push(Number(match[1]));
    renderRequests.push(
      markers.filter((candidate) =>
        candidate.startsWith(`TS_RENDER_REQUESTED traceId=${traceId} `),
      ).length,
    );
    frames.push(
      markers.filter((candidate) =>
        candidate.startsWith(`TS_FRAME_STARTED traceId=${traceId} `),
      ).length,
    );
  }
  await host.shutdown();
  return Object.freeze({
    ...summarize(durations),
    maximumRenderRequestsPerClick: Math.max(...renderRequests),
    maximumFramesPerClick: Math.max(...frames),
  });
}

function summarize(
  values: readonly number[],
): Omit<FocusLatencySummary, "maximumRenderRequestsPerClick" | "maximumFramesPerClick"> {
  if (values.length === 0) throw new Error("Focus benchmark requires samples.");
  const sorted = [...values].sort((first, second) => first - second);
  return Object.freeze({
    samples: sorted.length,
    minimumMs: sorted[0] ?? 0,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maximumMs: sorted.at(-1) ?? 0,
  });
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for the focus benchmark.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const summary = await benchmarkFocusLatency();
  console.log(`FOCUS_LATENCY_BENCHMARK ${JSON.stringify(summary)}`);
}
