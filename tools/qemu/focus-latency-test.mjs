import { access, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { QmpClient } from "./qmp-client.mjs";
import { resolveQemuInvocation } from "./qemu-launcher.mjs";

const output = resolve(import.meta.dirname, "build");
const qmpPath = resolve(output, "focus-latency-qmp.sock");
const serialPath = resolve(output, "focus-latency-serial.log");
const width = 1280;
const height = 720;
await Promise.all([
  access(resolve(output, "vmlinuz")),
  access(resolve(output, "initramfs.cpio.gz")),
  access(resolve(output, "sevynos-live.iso")),
]);
await Promise.all([rm(qmpPath, { force: true }), rm(serialPath, { force: true })]);
const argumentsValue = [
  "-m",
  "4096",
  "-smp",
  "4",
  "-kernel",
  resolve(output, "vmlinuz"),
  "-initrd",
  resolve(output, "initramfs.cpio.gz"),
  "-drive",
  `file=${resolve(output, "sevynos-live.iso")},media=cdrom,readonly=on`,
  "-append",
  "boot=live components live-media-path=/live init=/init console=ttyS0 panic=-1 sevyn.live=1 video=Virtual-1:1280x720@60 sevyn.focus-trace=1",
  "-device",
  "virtio-vga,xres=1280,yres=720",
  "-device",
  "qemu-xhci",
  "-device",
  "usb-kbd",
  "-device",
  "usb-tablet,id=sevyn-tablet",
  "-display",
  "none",
  "-serial",
  `file:${serialPath}`,
  "-qmp",
  `unix:${qmpPath},server=on,wait=off`,
  "-no-reboot",
];
const invocation = await resolveQemuInvocation(output, argumentsValue, { visible: true });
const child = spawn(invocation.command, invocation.arguments, {
  stdio: ["ignore", "ignore", "pipe"],
});
let qemuError = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  qemuError += chunk;
});
let qmp;
try {
  await waitForMarker(
    serialPath,
    "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED",
    120_000,
  );
  await waitForMarker(serialPath, "SEVYN_QEMU_FOCUS_TRACE_ENABLED", 10_000);
  await waitForMarker(serialPath, "RUST_FOCUS_TRACE_ENABLED", 10_000);
  const bounds = await waitForWindowBounds(serialPath, 120_000);
  const firstPoint = exposedPoint(bounds.get("window-1"), bounds.get("window-2"));
  const secondPoint = exposedPoint(bounds.get("window-2"), bounds.get("window-1"));
  qmp = await QmpClient.connect(qmpPath);
  const pointingDevices = await qmp.command("query-mice");
  const tablet = pointingDevices.find((device) =>
    device.name.toLowerCase().includes("tablet"),
  );
  if (tablet === undefined) throw new Error("QEMU did not expose the USB tablet.");
  const mouseSelection = await qmp.command("human-monitor-command", {
    "command-line": `mouse_set ${String(tablet.index)}`,
  });
  if (mouseSelection.trim() !== "")
    throw new Error(`QEMU could not select the USB tablet: ${mouseSelection.trim()}`);
  const samples = [];
  for (let index = 1; index <= 20; index += 1) {
    const first = index % 2 === 1;
    const point = first ? firstPoint : secondPoint;
    const target = first ? "window-1" : "window-2";
    await qmp.command("input-send-event", {
      events: [
        { type: "abs", data: { axis: "x", value: absolute(point.x, width) } },
        { type: "abs", data: { axis: "y", value: absolute(point.y, height) } },
      ],
    });
    if (index === 1)
      await waitForMarker(serialPath, "SEVYN_GENESIS_POINTER_INPUT_RECEIVED", 10_000);
    // Positioning the virtual tablet can itself invalidate hover state. Let that
    // frame settle so this benchmark measures click-to-focused-frame latency,
    // rather than charging an unrelated pointer-move frame to the click.
    await pause(300);
    await qmp.command("human-monitor-command", {
      "command-line": "mouse_button 1",
    });
    await qmp.command("human-monitor-command", {
      "command-line": "mouse_button 0",
    });
    const traceId = `focus-${String(index)}`;
    await waitForMarker(
      serialPath,
      `TS_FOCUS_STATE_UPDATED traceId=${traceId} windowId=${target}`,
      10_000,
    );
    samples.push(await waitForTraceSample(serialPath, traceId, 10_000));
  }
  const summary = summarize(samples.map((sample) => sample.totalDurationMs));
  const raster = summarize(samples.map((sample) => sample.rasterDurationMs));
  const copy = summarize(samples.map((sample) => sample.copyDurationMs));
  const maximumRenderRequestsPerClick = Math.max(
    ...samples.map((sample) => sample.renderRequests),
  );
  const maximumFramesPerClick = Math.max(...samples.map((sample) => sample.frames));
  console.log(
    `QEMU_FOCUS_LATENCY ${JSON.stringify({ resolution: "1280x720", ...summary, raster, copy, maximumRenderRequestsPerClick, maximumFramesPerClick })}`,
  );
  if (summary.maximumMs > 250)
    throw new Error(
      `Focus latency remained unacceptable: maximum ${String(summary.maximumMs)} ms.`,
    );
  await qmp.command("quit");
  qmp.close();
  qmp = undefined;
} catch (error) {
  if (qemuError.trim() !== "") console.error(qemuError.trim());
  throw error;
} finally {
  qmp?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function waitForWindowBounds(path, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const contents = await readFile(path, "utf8").catch(() => "");
    const values = new Map();
    for (const match of contents.matchAll(
      /GENESIS_WINDOW_BOUNDS reason=initial windowId=(window-[12]) x=([\d.-]+) y=([\d.-]+) width=([\d.-]+) height=([\d.-]+)/g,
    ))
      values.set(match[1], {
        x: Number(match[2]),
        y: Number(match[3]),
        width: Number(match[4]),
        height: Number(match[5]),
      });
    if (values.size === 2) return values;
    await pause(100);
  }
  throw new Error("Timed out waiting for initial window geometry.");
}

function exposedPoint(target, occluder) {
  if (target === undefined) throw new Error("Target window bounds were not reported.");
  for (let y = target.y + 54; y <= target.y + target.height - 12; y += 8)
    for (let x = target.x + 12; x <= target.x + target.width - 12; x += 8)
      if (
        occluder === undefined ||
        x < occluder.x ||
        x >= occluder.x + occluder.width ||
        y < occluder.y ||
        y >= occluder.y + occluder.height
      )
        return { x, y };
  throw new Error("The cascaded window has no exposed activation point.");
}

function absolute(value, extent) {
  return Math.max(0, Math.min(32767, Math.round((value / (extent - 1)) * 32767)));
}

function traceSample(log, traceId) {
  return {
    totalDurationMs: metric(log, traceId, "FOCUS_TRACE_PRESENTED", "totalDurationMs"),
    rasterDurationMs: metric(log, traceId, "TS_FRAME_RASTERIZED", "durationMs"),
    copyDurationMs: metric(log, traceId, "RUST_BUFFER_COPIED", "durationMs"),
    renderRequests: metric(
      log,
      traceId,
      "TS_FOCUS_FRAME_ACKNOWLEDGED",
      "renderRequests",
    ),
    frames: metric(log, traceId, "TS_FOCUS_FRAME_ACKNOWLEDGED", "frames"),
  };
}

function metric(log, traceId, event, field) {
  const line = log
    .split("\n")
    .find(
      (candidate) =>
        candidate.includes(event) && candidate.includes(`traceId=${traceId}`),
    );
  const match = new RegExp(`${field}=([\\d.]+)`).exec(line ?? "");
  if (match?.[1] === undefined)
    throw new Error(`${event} did not report ${field} for ${traceId}.`);
  return Number(match[1]);
}

function summarize(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return {
    samples: sorted.length,
    minimumMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maximumMs: sorted.at(-1),
  };
}

function percentile(sorted, value) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

async function waitForTraceSample(path, traceId, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    const contents = await readFile(path, "utf8").catch(() => "");
    try {
      return traceSample(contents, traceId);
    } catch (error) {
      lastError = error;
    }
    await pause(20);
  }
  throw new Error(`Timed out waiting for complete metrics for ${traceId}.`, {
    cause: lastError,
  });
}

async function waitForMarker(path, marker, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.includes(marker)) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${marker}.`);
}

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
