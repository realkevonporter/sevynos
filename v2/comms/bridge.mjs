// SevynOS v2 M10 — media bridge: the WebRTC engine for commsd's calls.
//
// commsd speaks Matrix signaling (m.call.*) but owns no PeerConnection
// — Node has none, and react-native-webrtc has no Linux target. The
// bridge is the PeerConnection:
//
//   ChromiumBridge — a headless Chromium page (bridge.html) driven over
//                      CDP. Chromium 159 ships in the image with full
//                      WebRTC; the page runs RTCPeerConnection, renders
//                      the remote video in the Chromium window (detached
//                      from the RN calling app, exactly as M5's browser
//                      windowing is detached), and reports connection
//                      state + frames received. With --use-fake-device-
//                      for-media-stream the bridge proves media end to
//                      end without a camera (the check's synthetic
//                      camera); without it, real camera/mic on hardware.
//   NullBridge     — no Chromium present. Produces a syntactically valid
//                      SDP offer/answer with port-0 (inactive) media
//                      sections and no ICE candidates. Signaling is fully
//                      real; media is explicitly none. The daemon reports
//                      media: "none" so no UI or check can mistake this
//                      for a working call.
//
// Interface (both): startCall({callId, video}) -> {sdp}
//   prepareAnswer(call) -> {sdp}   (call.offerSdp is the remote offer)
//   answerCall(call) -> {sdp}      (returns the prepared answer)
//   setRemoteAnswer(call, sdp) -> void
//   addIceCandidate(call, candidate) -> void
//   takeCandidates(callId) -> [{candidate, sdpMid, sdpMLineIndex}]
//   endCall(callId) -> void
//   mediaState() -> "none" | "connecting" | "connected"
//   close() -> void

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A syntactically valid SDP offer with no usable media: port-0
// (rejected) audio + optional video, inactive, no candidates. A real
// peer sets it, gets no media, and the call stays signaling-only.
// Never presented as a working call — mediaState() stays "none".
function nullSdp(video) {
  const m = ["v=0", "o=sevyn 0 0 IN IP4 127.0.0.1", "s=SevynOS call", "t=0 0"];
  m.push("m=audio 0 UDP/TLS/RTP/SAVPF 0", "c=IN IP4 0.0.0.0", "a=inactive", "a=mid:0");
  if (video) {
    m.push("m=video 0 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=inactive", "a=mid:1");
  }
  return m.join("\r\n") + "\r\n";
}

export class NullBridge {
  async startCall({ video }) {
    return { sdp: nullSdp(video) };
  }
  async prepareAnswer(call) {
    return { sdp: nullSdp(call.video) };
  }
  async answerCall(call) {
    if (call.answerSdp) return { sdp: call.answerSdp };
    return this.prepareAnswer(call);
  }
  async setRemoteAnswer() {}
  async addIceCandidate() {}
  async takeCandidates() {
    return [];
  }
  async endCall() {}
  mediaState() {
    return "none";
  }
  async refreshMediaState() {
    return "none";
  }
  // Raw stats for diagnostics (the CALLS verb reports only the
  // mapped state; the daemon logs these numbers while a call is
  // live so a stuck "connecting" can be told apart from a dead
  // bridge — ICE connected with zero frames vs ICE never connected).
  async rawMediaState() {
    return { connectionState: "none", framesReceived: 0, calls: 0 };
  }
  async getTimings() {
    return null;
  }
  async close() {}
}

// ---------------------------------------------------------------------------
// Chromium bridge (CDP)
// ---------------------------------------------------------------------------
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

export class ChromiumBridge {
  constructor({ chromeBin, page, fakeMedia = true }) {
    this.chromeBin = chromeBin || process.env.SEVYN_CHROME || "chromium";
    this.page = page || process.env.SEVYN_BRIDGE_PAGE || "";
    this.fakeMedia = fakeMedia;
    this.proc = null;
    this.port = 0;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.calls = new Map(); // callId -> { video }
    this.candidateQueue = new Map(); // callId -> [candidate, ...]
    this.started = false;
    this.starting = null; // in-flight ensureStarted() promise (mutex)
  }

  async ensureStarted(timeoutMs = 8000) {
    if (this.started) return;
    // Two calls can race (incoming-call prep + a CALLS refresh, or
    // ANSWER while prep is still starting Chromium). Without this
    // mutex both spawn a Chromium and overwrite this.ws — the first
    // one's CDP sends then hit a still-CONNECTING socket ("Sent
    // before connected").
    if (!this.starting) {
      this.starting = this.doStart().then(
        () => {
          this.started = true;
          this.starting = null;
        },
        (e) => {
          this.starting = null;
          throw e;
        },
      );
    }
    // Race the (possibly in-flight) start against a deadline. The
    // host kills any `sevyn` exec after 10 s, and a cold Chromium
    // takes ~15-25 s — so a verb that arrives mid-warmup must fail
    // FAST with "still starting" (the caller retries; the warmup
    // keeps running in the background) instead of hanging until the
    // host SIGKILLs it (exit 124, invite never sent). The daemon's
    // boot pre-warm passes a long timeout; verb calls use the
    // 8 s default, leaving ~2 s for the rest of the verb.
    let timer;
    try {
      await Promise.race([
        this.starting,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("media engine still starting")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async doStart() {
    const port = 9333 + Math.floor(Math.random() * 500);
    this.port = port;
    // A per-instance profile dir (no cross-run lock fights) and a
    // detached process group, so close() can kill the whole Chromium
    // tree — SIGTERM to the main process alone leaves the renderer /
    // zygote / crashpad children behind (277 orphans in one debug
    // session proved it).
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "sevyn-bridge-"));
    this.profileDir = profileDir;
    try {
      return await this.doStartInner(port, profileDir);
    } catch (e) {
      // A failed start must not leave its Chromium behind: the next
      // ensureStarted() spawns a fresh one, and under TCG each
      // orphan eats the CPU the retry needs (the CI round-2 warm
      // died at the page wait and every verb retry spawned another
      // Chromium the same way).
      this.killProc();
      throw e;
    }
  }

  killProc() {
    if (this.proc && !this.proc.killed) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    this.proc = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  async doStartInner(port, profileDir) {
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--window-size=1280,720",
      "--autoplay-policy=no-user-gesture-required",
    ];
    if (this.fakeMedia) {
      args.push("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream");
    }
    this.proc = spawn(this.chromeBin, args, { stdio: "ignore", detached: true });
    this.proc.on("error", () => {});
    // Wait for the DevTools HTTP endpoint. 60 s, not 15: under TCG
    // (CI) a cold Chromium takes far longer than 15 s to come up.
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
        if (version.webSocketDebuggerUrl) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline)
        throw new Error("chromium did not start a DevTools endpoint");
      await new Promise((r) => setTimeout(r, 200));
    }
    const wsUrl = (await httpGetJson(`http://127.0.0.1:${port}/json/version`))
      .webSocketDebuggerUrl;
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    };
    // Open the bridge page in its own target.
    const pageUrl = this.page ? `file://${this.page}` : "about:blank";
    const target = await this.cdp("Target.createTarget", { url: pageUrl });
    this.targetId = target.targetId;
    const attached = await this.cdp("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.cdp("Runtime.enable", {}, this.sessionId);
    await this.cdp("Page.enable", {}, this.sessionId);
    // Wait for __sevynCall to exist (the page loads its script).
    // 120 s, not 10: under TCG (CI) the renderer takes minutes to
    // reach a usable page — the 2026-11-11 CI round-2 failure was
    // exactly this wait expiring while the page was still loading,
    // which killed the warm and left every CALL/ANSWER verb failing
    // with exit 1 (call stuck "ringing"). Must fit inside the
    // pre-warm's 300 s budget (DevTools 60 s + this 120 s).
    const deadline2 = Date.now() + 120000;
    for (;;) {
      const r = await this.eval(`typeof window.__sevynCall`);
      if (r?.result?.value === "object") break;
      if (Date.now() > deadline2)
        throw new Error("bridge page did not expose __sevynCall");
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      // The socket is nulled by close() (SHUTDOWN / SIGTERM). A pump
      // or refresh in flight at that moment must get a clean "bridge
      // closed" error, not a TypeError on a null .send — the daemon
      // catches that and ends the pump instead of crashing.
      if (!this.ws) {
        reject(new Error("bridge closed (CDP socket gone)"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
      // 180 s, not 15: a Runtime.evaluate with awaitPromise runs the
      // page's whole async function (getUserMedia + SDP for
      // createOffer/createAnswer) — under TCG that takes >60 s, so
      // the 15 s limit (then the 60 s limit) rejected the call while
      // the page was still working on it (check9 + check10: "CDP
      // timeout for Runtime.evaluate" on bob's prepareAnswer).
      // Must fit the 180 s answer budget (ring timer + invite
      // lifetime, below). A genuinely hung page still times out —
      // just later.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 180000);
    });
  }

  async eval(expression) {
    const r = await this.cdp(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (r?.exceptionDetails) {
      throw new Error(
        `bridge page error: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`,
      );
    }
    return r;
  }

  async callFn(fn, arg) {
    const expr = `window.__sevynCall.${fn}(${JSON.stringify(arg ?? null)})`;
    const r = await this.eval(expr);
    // A page function that throws comes back with exceptionDetails
    // and no value — without this check the failure is silent (the
    // caller sees undefined and carries on). Surface it as a real
    // rejection so the daemon can log it.
    if (r?.exceptionDetails) {
      const ex = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`bridge ${fn} threw: ${ex}`);
    }
    return r?.result?.value;
  }

  async startCall({ callId, video, iceServers }) {
    await this.ensureStarted();
    this.calls.set(callId, { video });
    this.candidateQueue.set(callId, []);
    const offer = await this.callFn("createOffer", { callId, video, iceServers });
    // Drain local candidates into the queue (the page pushes them as
    // they gather; takeCandidates polls the page).
    return { sdp: offer.sdp };
  }

  async prepareAnswer(call) {
    await this.ensureStarted();
    // Serialize per callId: the invite-time background prep and an
    // ANSWER verb (or its retry) can overlap, and two concurrent
    // createAnswer runs race on the same callId — the second
    // newPc() replaces the PC while the first is still building
    // its answer, and whichever finishes last overwrites
    // answerSdp with the OTHER pc's SDP (wrong ufrag → ICE never
    // pairs). Concurrent callers await the one in-flight promise.
    const existing = this.prepPromises?.get(call.callId);
    if (existing) return existing;
    const p = (async () => {
      this.calls.set(call.callId, { video: call.video });
      this.candidateQueue.set(call.callId, []);
      const answer = await this.callFn("createAnswer", {
        callId: call.callId,
        offerSdp: call.offerSdp,
        iceServers: call.iceServers || [],
      });
      return { sdp: answer.sdp };
    })();
    this.prepPromises ??= new Map();
    this.prepPromises.set(call.callId, p);
    try {
      return await p;
    } finally {
      if (this.prepPromises.get(call.callId) === p) this.prepPromises.delete(call.callId);
    }
  }

  async answerCall(call) {
    if (call.answerSdp) return { sdp: call.answerSdp };
    return this.prepareAnswer(call);
  }

  async setRemoteAnswer(call, sdp) {
    await this.callFn("setRemoteAnswer", { callId: call.callId, sdp });
  }

  async addIceCandidate(call, candidate) {
    const r = await this.callFn("addIceCandidate", { callId: call.callId, candidate });
    if (r && r.ok === false) {
      throw new Error(`addIceCandidate: ${r.error || "failed"}`);
    }
  }

  async takeCandidates(callId) {
    if (!this.started) return [];
    const fresh = (await this.callFn("takeCandidates", { callId })) || [];
    return fresh;
  }

  async endCall(callId) {
    this.calls.delete(callId);
    this.candidateQueue.delete(callId);
    if (this.started) {
      try {
        await this.callFn("closeCall", { callId });
      } catch {
        /* page may be gone */
      }
    }
  }

  mediaState() {
    if (!this.started) return "none";
    // Synchronous view is not available over CDP; the daemon refreshes
    // this from getStats when reporting. "connecting" while any call
    // is live, "connected" once frames flow (see refreshMediaState).
    return this.calls.size > 0 ? "connecting" : "none";
  }

  async refreshMediaState() {
    if (!this.started || this.calls.size === 0) return "none";
    try {
      const stats = await this.rawMediaState();
      // "connected" means frames are actually flowing — ICE connected
      // without frames is still "connecting" here, never faked.
      if (stats && stats.framesReceived > 0 && stats.connectionState === "connected") {
        return "connected";
      }
      return "connecting";
    } catch {
      return "connecting";
    }
  }

  // Raw getStats numbers for the daemon's diagnostics log.
  async rawMediaState() {
    if (!this.started || this.calls.size === 0) {
      return { connectionState: "none", framesReceived: 0, calls: 0 };
    }
    return await this.callFn("getStats", {});
  }

  // The page's per-step createAnswer timings (synchronous read —
  // safe to call while a createAnswer is stuck, unlike getStats,
  // which awaits pc.getStats() and can itself hang on a mid-answer
  // PC). Null until the first call.
  async getTimings() {
    if (!this.started) return null;
    return await this.callFn("getTimings", {});
  }

  async close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    if (this.proc) {
      const pid = this.proc.pid;
      // Kill the whole process group (detached spawn): SIGTERM, then
      // SIGKILL after a grace period. The main process alone is not
      // enough — its renderer/zygote children survive it.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    if (this.profileDir) {
      await fs.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
      this.profileDir = null;
    }
    this.started = false;
    this.starting = null;
  }
}
