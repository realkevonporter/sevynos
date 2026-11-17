// SevynOS v2 Camera v1 — unit test for camera-page.js.
//
// Runs the page script in node:vm with DOM stubs (no browser, no
// Chromium): a fake getUserMedia that resolves, a fake video element,
// a fake canvas. Proves the state machine (starting -> ready, error
// on denial), the capture contract (JPEG + PNG data URLs of the
// current frame), and that capture refuses before frames exist.
//
// Run: node test-camera-page.mjs   (from v2/camera)
// Exit 0 = all checks pass.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "camera-page.js"), "utf8");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log("  ok: " + name);
  else {
    console.log("FAIL: " + name + (detail ? " " + detail : ""));
    failures++;
  }
}
function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- DOM stubs ----------------------------------------------------------
function makeEnv({ gum = "resolve" } = {}) {
  const listeners = {};
  const video = {
    videoWidth: 0,
    videoHeight: 0,
    readyState: 0,
    srcObject: null,
    play: async () => {
      video.videoWidth = 1280;
      video.videoHeight = 720;
      video.readyState = 4;
    },
    addEventListener: (ev, fn) => {
      listeners[ev] = fn;
    },
  };
  const statusEl = { textContent: "" };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
    }),
    toDataURL: (type) => {
      if (type === "image/jpeg") return "data:image/jpeg;base64,/9j/AAAA";
      return "data:image/png;base64,iVBORAAAA";
    },
  };
  const documentStub = {
    readyState: "complete",
    title: "",
    getElementById: (id) => (id === "preview" ? video : statusEl),
    createElement: (tag) => {
      if (tag !== "canvas") throw new Error("unexpected element " + tag);
      return canvas;
    },
    addEventListener: () => {},
  };
  const gumImpl =
    gum === "resolve"
      ? async () => ({})
      : async () => {
          throw new Error("Permission denied");
        };
  const windowStub = {};
  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: { mediaDevices: { getUserMedia: gumImpl } },
    console,
    Date,
  };
  sandbox.window = windowStub;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "camera-page.js" });
  return { sandbox, video, statusEl, canvas, windowStub, documentStub };
}

async function main() {
  // Happy path: getUserMedia resolves -> ready, capture works.
  {
    const { windowStub, video, documentStub } = makeEnv();
    await tick(20);
    check(
      "page: state ready after getUserMedia",
      windowStub.__sevynCamera.state() === "ready",
    );
    check(
      "page: title reports ready + size",
      documentStub.title === "Camera ready 1280x720",
      documentStub.title,
    );
    const shot = windowStub.__sevynCamera.capture();
    check(
      "page: capture returns JPEG data URL",
      shot.jpeg.startsWith("data:image/jpeg;base64,"),
    );
    check(
      "page: capture returns PNG data URL",
      shot.png.startsWith("data:image/png;base64,"),
    );
    check("page: capture reports frame size", shot.width === 1280 && shot.height === 720);
    check("page: video has a stream", video.srcObject !== null);
  }

  // Capture before ready throws (no frames yet).
  {
    const { windowStub } = makeEnv();
    let threw = "";
    try {
      windowStub.__sevynCamera.capture();
    } catch (e) {
      threw = e.message;
    }
    check("page: capture before ready throws", /not ready/.test(threw), threw);
  }

  // getUserMedia denial -> error state, title carries the failure.
  {
    const { sandbox, windowStub } = makeEnv({ gum: "reject" });
    await tick(20);
    check("page: state error after denial", windowStub.__sevynCamera.state() === "error");
    check(
      "page: error() names the denial",
      /Permission denied/.test(windowStub.__sevynCamera.error()),
    );
    check(
      "page: title reports the error",
      /Camera error: Permission denied/.test(sandbox.document.title),
    );
    let threw = "";
    try {
      windowStub.__sevynCamera.capture();
    } catch (e) {
      threw = e.message;
    }
    check("page: capture in error state throws", /not ready: error/.test(threw), threw);
  }

  // No getUserMedia at all (old Chromium / no media stack).
  {
    const fresh = (() => {
      const documentStub = {
        readyState: "complete",
        title: "",
        getElementById: (id) =>
          id === "preview"
            ? {
                videoWidth: 0,
                videoHeight: 0,
                readyState: 0,
                play: async () => {},
                addEventListener: () => {},
              }
            : { textContent: "" },
        createElement: () => {
          throw new Error("no canvas expected");
        },
        addEventListener: () => {},
      };
      const win = {};
      const sb = { window: win, document: documentStub, navigator: {}, console, Date };
      vm.createContext(sb);
      vm.runInContext(SRC, sb, { filename: "camera-page.js" });
      return sb;
    })();
    await tick(20);
    check(
      "page: state error without getUserMedia",
      fresh.window.__sevynCamera.state() === "error",
    );
    check(
      "page: error names getUserMedia",
      /getUserMedia not available/.test(fresh.window.__sevynCamera.error()),
    );
  }

  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("camera-page tests passed");
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
