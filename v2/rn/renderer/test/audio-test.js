"use strict";
// Node test for the Sevyn audio adapter (mock Sevyn host).
// Run: node test/audio-test.js   (from v2/rn/renderer; no react
// needed — the adapter only talks to the Sevyn.audio* host
// functions, which the mock implements as a fake in-memory audiod.)
const assert = require("node:assert/strict");

global.Sevyn = require("./mock-sevyn");
const { AudiodError, SevynAudio, SevynMedia } = require("../sevyn-audio");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log("ok - " + name);
}

function calls() {
  return Sevyn._audio.calls.length;
}

async function rejectsWithCode(promise, code) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AudiodError, "rejected with an AudiodError");
  assert.equal(err.code, code, "code is " + code);
  return err;
}

(async () => {
  // media and audio are one implementation under two names.
  check("media and audio are the same adapter object", () => {
    assert.equal(SevynMedia, SevynAudio);
  });

  await checkAsync("play reports the daemon's real duration and position", async () => {
    Sevyn._audioReset();
    const status = await SevynAudio.play("/data/01-sunrise-acoustic.wav");
    assert.equal(status.playing, true);
    assert.equal(status.durationSec, 21.5);
    assert.equal(status.currentPositionSec, 0);
    assert.equal(status.track.format, "wav");
    const sought = await SevynAudio.seek(10);
    assert.equal(sought.currentPositionSec, 10);
    // Position comes from the daemon, not a client clock: two
    // status calls with no seek in between report the same value.
    const first = await SevynAudio.status();
    const second = await SevynAudio.status();
    assert.equal(first.currentPositionSec, 10);
    assert.equal(second.currentPositionSec, 10);
    await SevynAudio.stop();
  });

  await checkAsync(
    "play rejects a missing, non-audio, and undecodable file cleanly",
    async () => {
      Sevyn._audioReset();
      await rejectsWithCode(SevynAudio.play("/data/missing.wav"), "not-found");
      await rejectsWithCode(SevynAudio.play("/data/not-audio.wav"), "unsupported-format");
      await rejectsWithCode(SevynAudio.play("/data/boom.wav"), "decode-error");
      const status = await SevynAudio.status();
      assert.equal(status.playing, false);
    },
  );

  await checkAsync("bad play arguments are rejected before any I/O", async () => {
    Sevyn._audioReset();
    const before = calls();
    for (const bad of ["", "relative/path.wav", "   "]) {
      await rejectsWithCode(SevynAudio.play(bad), "bad-argument");
    }
    await rejectsWithCode(SevynAudio.play({ path: "" }), "bad-argument");
    await rejectsWithCode(SevynAudio.play(null), "bad-argument");
    assert.equal(calls(), before, "no host call was made");
  });

  await checkAsync("pause/resume/seek while idle reject with the idle code", async () => {
    Sevyn._audioReset();
    await rejectsWithCode(SevynAudio.pause(), "idle");
    await rejectsWithCode(SevynAudio.resume(), "idle");
    await rejectsWithCode(SevynAudio.seek(5), "idle");
    const stopped = await SevynAudio.stop();
    assert.equal(stopped.playing, false);
  });

  await checkAsync("pause, resume, and seek flow with daemon positions", async () => {
    Sevyn._audioReset();
    await SevynAudio.play("/data/01-sunrise-acoustic.wav");
    await SevynAudio.seek(3);
    const paused = await SevynAudio.pause();
    assert.equal(paused.paused, true);
    assert.equal(paused.currentPositionSec, 3);
    const resumed = await SevynAudio.resume();
    assert.equal(resumed.paused, false);
    const sought = await SevynAudio.seek(10);
    assert.equal(sought.currentPositionSec, 10);
    const stopped = await SevynAudio.stop();
    assert.equal(stopped.playing, false);
    assert.equal(stopped.currentPositionSec, 0);
  });

  await checkAsync(
    "bad seeks are rejected before I/O; out-of-range comes from the daemon",
    async () => {
      Sevyn._audioReset();
      await SevynAudio.play("/data/01-sunrise-acoustic.wav");
      const before = calls();
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "60"]) {
        await rejectsWithCode(SevynAudio.seek(bad), "bad-argument");
      }
      assert.equal(calls(), before, "no host call was made");
      await rejectsWithCode(SevynAudio.seek(9999), "out-of-range");
      const status = await SevynAudio.status();
      assert.equal(status.playing, true);
      await SevynAudio.stop();
    },
  );

  await checkAsync("volume clamps like the daemon and rejects non-numbers", async () => {
    Sevyn._audioReset();
    await SevynAudio.play("/data/01-sunrise-acoustic.wav");
    const fifty = await SevynAudio.setVolume(50);
    assert.equal(fifty.volume, 50);
    const high = await SevynAudio.setVolume(150);
    assert.equal(high.volume, 100);
    const low = await SevynAudio.setVolume(-5);
    assert.equal(low.volume, 0);
    const before = calls();
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "loud",
    ]) {
      await rejectsWithCode(SevynAudio.setVolume(bad), "bad-argument");
    }
    assert.equal(calls(), before, "no host call was made");
    const status = await SevynAudio.status();
    assert.equal(status.playing, true);
    assert.equal(status.volume, 0);
    await SevynAudio.stop();
  });

  await checkAsync(
    "scan reports the daemon's real durations, never hardcoded ones",
    async () => {
      Sevyn._audioReset();
      const tracks = await SevynAudio.scan("/data");
      assert.equal(tracks.length, 2);
      assert.equal(tracks[0].durationSec, 21.5);
      assert.equal(tracks[1].durationSec, 200);
      assert.ok(!tracks.map((t) => t.durationSec).includes(210), "no hardcoded duration");
      await rejectsWithCode(SevynAudio.scan("/data/no-such-dir"), "not-found");
      await rejectsWithCode(SevynAudio.scan(""), "bad-argument");
      const defaults = await SevynAudio.scan();
      assert.equal(defaults.length, 2, "scan with no dir uses the default");
    },
  );

  await checkAsync(
    "a missing host function is audio-unavailable, and the adapter stays usable",
    async () => {
      Sevyn._audioReset();
      const realStatus = Sevyn.audioStatus;
      try {
        delete Sevyn.audioStatus;
        await rejectsWithCode(SevynAudio.status(), "audio-unavailable");
      } finally {
        Sevyn.audioStatus = realStatus;
      }
      const status = await SevynAudio.play("/data/01-sunrise-acoustic.wav");
      assert.equal(status.playing, true);
      await SevynAudio.stop();
    },
  );

  await checkAsync(
    "a malformed host reply is audio-unavailable, not a crash",
    async () => {
      Sevyn._audioReset();
      const realStatus = Sevyn.audioStatus;
      try {
        Sevyn.audioStatus = () => Promise.resolve("this is not json");
        await rejectsWithCode(SevynAudio.status(), "audio-unavailable");
      } finally {
        Sevyn.audioStatus = realStatus;
      }
      const status = await SevynAudio.status();
      assert.equal(status.playing, false);
    },
  );

  await checkAsync(
    "a storm of bad calls all settles, and playback still works",
    async () => {
      Sevyn._audioReset();
      const badCalls = [
        SevynAudio.play(""),
        SevynAudio.play("/data/missing.wav"),
        SevynAudio.play("/data/not-audio.wav"),
        SevynAudio.seek(Number.NaN),
        SevynAudio.seek(-1),
        SevynAudio.setVolume(Number.NaN),
        SevynAudio.setVolume("loud"),
        SevynAudio.pause(),
        SevynAudio.resume(),
        SevynAudio.scan(""),
        SevynAudio.scan("/data/no-such-dir"),
      ];
      const storm = await Promise.allSettled([
        ...badCalls,
        ...badCalls,
        ...badCalls,
        ...badCalls,
        ...badCalls,
      ]);
      assert.equal(storm.length, 55);
      for (const result of storm) {
        assert.equal(result.status, "rejected");
        assert.ok(result.reason instanceof AudiodError);
        assert.equal(typeof result.reason.code, "string");
      }
      const status = await SevynAudio.play("/data/01-sunrise-acoustic.wav");
      assert.equal(status.playing, true);
      assert.equal(status.durationSec, 21.5);
      await SevynAudio.stop();
    },
  );

  await checkAsync(
    "the media adapter plays through the same implementation",
    async () => {
      Sevyn._audioReset();
      const status = await SevynMedia.play("/data/song.mp3");
      assert.equal(status.playing, true);
      assert.equal(status.durationSec, 200);
      assert.equal(status.track.format, "mp3");
      const stopped = await SevynMedia.stop();
      assert.equal(stopped.playing, false);
    },
  );

  await checkAsync(
    "a caller-supplied track wins over the daemon's bare track",
    async () => {
      Sevyn._audioReset();
      const status = await SevynAudio.play({
        path: "/data/01-sunrise-acoustic.wav",
        track: {
          id: "lib-1",
          title: "Sunrise (Library)",
          artist: "Test Artist",
          album: "Test Album",
        },
      });
      assert.equal(status.track.id, "lib-1");
      assert.equal(status.track.title, "Sunrise (Library)");
      assert.equal(status.track.artist, "Test Artist");
      assert.equal(status.track.album, "Test Album");
      assert.equal(status.track.durationSec, 21.5);
      await SevynAudio.stop();
    },
  );

  await checkAsync(
    "output devices are the single static default (no daemon call)",
    async () => {
      Sevyn._audioReset();
      const before = calls();
      const outputs = await SevynAudio.getOutputs();
      assert.deepEqual(outputs, [
        {
          id: "default",
          name: "System Audio Output",
          isDefault: true,
          type: "speaker",
        },
      ]);
      const set = await SevynAudio.setOutput("default");
      assert.equal(set, null);
      assert.equal(calls(), before, "no host call was made");
    },
  );

  console.log(`\n${passed} audio checks passed`);
})();
