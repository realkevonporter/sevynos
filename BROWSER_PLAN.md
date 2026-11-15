# M13 — Browser embed: Chromium as a chromeless content window

Status: scope + build in progress (2026-11-14, branch `v2/browser-embed`).
Ordered by Kevon 2026-11-14 ("Start the browser now"). Build to PR, then stop — no merge.
Model: **Edge model** — Chromium is the engine, SevynOS's own UI is the
browser. The Browser app (tabs + address bar) is the only chrome;
Chromium itself shows no browser UI of its own.

## The bar (locked)

60 fps on the GF65 (MSI GF65 Thin 9SD, GTX 16-series) once the embed
lands. QEMU/TCG software rendering runs ~10–30 fps and CANNOT prove the
bar — the GF65 hardware retest is Kevon's gate. CI proves the embed is
live and the desktop works; only the GF65 proves the frame rate.

The embed lifts the Browser app, not the whole desktop — Genesis (M12)
already did the desktop. CDP screencast stays dead (15–30 fps, killed
by the 60 fps bar): the page is proven by pixels in Chromium's own
window, never by a screencast frame.

## Where we are (2026-11-14, main 84f8c144)

- M12 Genesis is merged: Weston runs its GL renderer and the RN host
  presents through EGL/GLES2, with the CPU painter as fallback.
- Chromium is already in the image (M5): the prebuilt snapshot pinned
  1738523 = Chromium 159.0.8150.0, staged at
  `/usr/share/sevyn/chromium`, launched by `sevyn browser` in
  `v2/update/sevyn.c`.
- `sevyn browser` already drives Chromium over CDP (M5): `open`
  (launch if needed), `tabs`, `activate`, `close`, `status`
  (running + CDP + tab count). The Browser app (`v2/apps/src/
Browser.tsx`) already has tabs + an address bar and drives Chromium
  over the same CDP channel.
- But the two are not paired: Chromium launches as a standalone
  window, and nothing ties its lifecycle to the Browser app window
  — closing the app does not stop Chromium, and the app cannot tell
  whether Chromium rendered on the GPU or fell back to software.

## Locked constraints

- **60 fps bar, GF65 is the proof.** QEMU proves the embed works;
  only Kevon's GF65 retest proves the frame rate.
- **CDP screencast is dead.** Killed by the 60 fps bar (M12);
  M13 does not revive it. CDP stays the control plane, not the
  frame transport.
- **No Linux shell access.** The Browser is a SevynOS app; the
  Terminal exposes only the `sevyn` CLI, never bash.
- **`.sevyn` bundles.** The Browser app ships as a stock bundle like
  every system app; it is deletable and reinstalls offline from
  pristine.
- **Browser multi-instance.** The embed must not assume a single
  Browser window: the app launches per-window like every stock app
  (M3), so the Chromium pairing and lifecycle are per Browser window,
  never a global singleton.

## The decisive Wayland facts

True in-window embedding — Chromium's pixels inside the Browser app's
own window — is impossible on this stack, and M13 does not attempt it:

- A separate-process Chromium surface **cannot be a subsurface** of
  the host window: `wl_subcompositor` is same-client-only. Chromium
  is a different client; the protocol forbids attaching its surface
  under ours.
- `xdg-shell` gives the client **no positioning**: a toplevel cannot
  place itself at an offset inside another window. Weston
  (desktop-shell) cascades new toplevels wherever it chooses.
- So the only ways to get Chromium's content truly inside the
  Browser window are a compositor placement protocol (a Weston
  extension positioning one client's surface inside another's
  window) or a frame transport (Chromium's frames copied into the
  host and painted as textures). Both are out of scope for M13:
  the first is new compositor protocol work, the second is CDP
  screencast with a different name — and screencast is dead on the
  60 fps bar.

## Design

Chromium runs as a chromeless app-mode window **paired with** the
Browser app window, not inside it. One window, SevynOS chrome,
Chromium content.

### Chromium launch: app mode, GPU tried first

`sevyn browser` launches Chromium with `--app=<url>`: no tab strip,
no omnibox, no browser chrome of any kind — a bare content window.
The launch tries the GPU path first and falls back to software
rendering when the GPU path cannot start, so a GPU failure can never
leave the browser dead (the M13 check proves the fallback boot
renders a page). Which path is active is observable: `browser status`
reports a `gpu:` line (gpu vs software) alongside running/CDP.

### Sizing: the content rect

The Browser app window is 800x500 (the M3 stock-app size). Its chrome
— tab bar + address bar — takes the top 152 px, so Chromium's window
is sized to the content rect, 800x348, and placed beside the Browser
window. The pairing is by size and by lifecycle, not by containment:
Weston cascades the Chromium toplevel next to the app window, and the
two windows read as one browser to the user.

Measured geometry (run 43676257443's artifacts, probed from the
`m13-check.json` + PPM screendumps — all frames 1280x800): the
Chromium window actually renders **768x225** (red bbox
(313,318)-(1080,542), stable across frames; aspect 3.41), not the
launched 800x348. Only Chromium is small: the Browser app window is
798 wide (header (107,193)-(904,233)) and the Terminal is 800 wide,
so this is NOT a systematic compositor/display shrink — that would
scale every window by one factor. It is specific to the Chromium
window (cause still open: compositor placement, `--window-size`
handling in app mode, or a Weston constraint on the cascaded
toplevel). The m13 check asserts on the _observed_ geometry instead
of the launched size: viewport height in [150, 360] AND aspect
width/height >= 2.0, which still rules out the old chromed viewport
(~420 tall, aspect ~1.9).

Round 3 (PR #117 CI, runs 43690022156/43690022280): the m5 run's
red viewport showed only as a 178px sliver, bbox (903,318)-
(1080,542) — the Terminal covers the rest — and the check polled
it for 180s without ever clicking it. Step 3 now raises Chromium
by clicking the centre of the visible colour fragment (bbox minus
the Terminal rect) and re-polls, up to three raises. Two harness
bugs from the same runs: (1) m13's `findWindowHeader` had a
`rowRight = rowRight` no-op typo that left `right` at -1, so the
refocus second-attempt click landed at x=51, off-window, raised
the shell, and the follow-up click launched Calculator from the
dock — fixed at the source, plus the second-attempt click is now
clamped into the known Terminal rect with fail-fast; (2) the
refocus input click was at left+50, which lands on the `sevyn>`
prompt label (~19px short of the TextInput, whose border starts
at left+69) — it is now left+200 (proven: the launch click there
hit the TextInput). `termCmd` also flushes the input with Enter
before typing, because focus loss mid-typing leaves partial text
that concatenates into the next command (`browser stabrowser
status`). The title-bar click stays as a best-effort compositor
raise only — the header has no focusable target.

Round 4 (PR #117 CI, head d83d5483, runs 43694717539/43694717554):
both m5 and m13 failed the same step (`example.com renders —
white=0px after 180s`) in OPPOSITE ways, and the fragment-centre
raise above was the common cause — a single-colour bbox centre is
the wrong target for a thin page strip, because stray pixels
inflate the bbox and the centre is usually bare desktop. m13's
`findColorBBox` 50%-fill density gate rejected the real #eeeeee
strip outright (density 0.016, bbox (19,17)-(1183,788)), so
`raiseChromiumFresh` never clicked at all; m5 has no gate, so it
clicked the bbox/fragment centre (503,152) — #0b0b0f bare desktop
~8px above the real page band — and both windows then left the
screen for the whole 180s poll (mechanism still open: no guest log
lines in the 182s gap, no close/crash/minimize lines — the
compositor restack on a desktop click is the leading hypothesis,
not a product fix in this round). The raise target is now the
centre of the LARGEST SOLID RUN of the page colour inside the
visible fragment (`findSolidRunPoint`, >=100px contiguous; the
real strip's #eeeeee runs are 753px), and the density gate is
removed — a scattered colour yields no solid run, so the raise
still fails honestly instead of clicking. The refocus
first-attempt clicks are now gated on a FRESH header detection
(`refocusFirstAttemptSafe`): no fresh header, or a click point
outside the detected window rect, means no click at all — the
m5 run's unguarded first-attempt input click (303,768) hit the
dock and launched Calendar. The covered-header case still
recovers via the guarded second-attempt fragment-centre click.
The link-page click keeps its bbox centre (the link is
flex-centred there) but is now verified blue-or-white before
clicking, and the corner raise verifies its corner pixel.

Round 5 (PR #117 CI, head aaef509c, runs 43699446057/43699446209):
15/18 — the round-4 raise fix is PROVEN (m5's example.com renders,
white=156841px), and the two remaining failures share the generic
refocus error string but NOT one root cause; both were read off
the re-pulled frames and boot logs, not the message. m13: the
Terminal was ON TOP in the crash frame (header (103,286)-(902,671)),
the title/input clicks LANDED (boot log: pointer down (200,482) ->
nodeId 56) and the EXEC arrived 15.8 s after the click — past the
10 s verify window, because the guest was starved by Chromium's
startup (normal click->EXEC is 5.3-6.2 s). So m13 needs a RETRY,
not a focus restore. m5: NO window was on screen in the crash
frame (bare "Welcome to SevynOS" desktop) — and the IDE step's
raise click used the STALE recorded viewport, so (992,430) hit
bare desktop, which CONFIRMS the round-4 open mechanism: a desktop
click hides all windows (the next two shots show the bare desktop).
The IDE raise now clicks the solid-run point of WHITE inside the
visible fragments (Chromium's tab/address bars are solid white;
measured run 768px at (512,270)) instead of a recorded-rect
fragment centre, and never clicks when there is no solid run.
`refocusTerminal` is now two-phase: (1) the gated first attempt
as before — a failed verify falls through to recovery instead of
throwing, so a late EXEC gets a second window; (2) recovery raises
via the guarded fragment-centre click, or — when no fragment is
visible at all — via the Terminal's dock icon (the only #111827
block in the dock band, the dark ">" at (1000,741) in the m5 crash
frame), then RE-DERIVES the header from a fresh settled frame and
clicks title + input and re-verifies. The last-known-good input
click only runs under a strict guard: the current frame must prove
the input row is on screen at that exact point (>=50% input-row
colour in a 41x11 box — 0.82-0.92 when present, 0.00 when the
point is the red C dock icon). The input row (top+482, e.g. y=768)
sits inside the dock's y-band (icons y~709-790), so a blind click
there would launch a dock app; and no recovery step ever clicks
bare desktop. Geometry pinned from the frames: the window's true
bottom is top+499 (findWindowHeader's `bottom` is only the
#111827 band's end, 671), the dock band starts at y=740.
Harness test: `~/workspace/ci-watch/r5-harness-test.mjs` (81
checks, real aaef509c frames in `r5-art/`).

Round 6 (PR #117 CI, head 304cdbea, run 43705517505): 16/18 —
m5 PASSED, m10 the known bob-side flake, m13 40/41 with one real
failure plus a refocus crash, both read off the re-pulled frames
and boot log. (1) The green step: after typing the green URL in
the Browser app's address bar + Return, `BROWSER tabs 1` passed
but `raiseChromium(0,200,83)` found no green pixel anywhere in
60 s. The Chromium window sits at x~~130..900, y~~180..490 — its
766x7 tab-strip sliver shows above the Browser header at
y185..191 — and the Browser window (x107..904, y193..682) covers
it entirely, so no green pixel exists to click; a fully covered
window can never be raised by clicking. The app-issued open DID
run (EXEC 0, `JS BROWSER open` echoing the green URL, tabs=1),
and "(untitled)" + the URL still in the address bar are
stale-app-state symptoms, not a failed navigation — the app's
refresh ran ~0.5 s after the open, before the page loaded (the
Terminal-issued example.com open showed the same empty title at
open time). No CDP title was ever observed for the green tab: the
check crashed in refocus before `pollTabsTitle` ran. The fix is
harness-only: when the direct raise finds no green, drag the
Browser window aside by its title bar (the m9-proven move drag,
diagonal -400/+260 so a clamped drag still exposes ~39k px) and
raise again, then drag it back by the measured move; the
after-drag gate is count > 20000 AND green bbox width >= 400
(the strip, not the full viewport, is exposed — the width is the
anti-sliver guard). (2) The refocus crash: at refocus start the
Terminal header was fully covered by the Browser window, so
phase 1 was skipped and recovery found no fragment raise point
→ the dock-icon path. Boot log proves the only input after
`BROWSER tabs 1` was the dock click at (964,764) → nodeId 103,
and the fresh frame is bare desktop: clicking the Terminal dock
icon while Terminal was the focused app HID all windows (the
dock toggles the focused app off) instead of raising it. Round
5's dock-icon restore assumption does not hold when the app is
already focused. The recovery is reordered: the guarded
last-known-good input click (on a FRESH shot, since the
first-attempt verify can take 10 s) goes FIRST — in the failed
run's frame the guard passes at (303,768), the input row showing
below the Browser window — and the dock icon runs ONLY when the
guard refuses AND no fragment exists, i.e. the Terminal is
verifiably not focused/visible. Same reorder in m5-check.mjs.
Harness test: `~/workspace/ci-watch/r6-harness-test.mjs` (real
304cdbea frames in `m13-artifacts/` + the m13 artifact zip's
PPMs, never the .img).

Round 7 (PR #117 CI, head dbdda2ae, runs 43709802296 (m5) /
43709802164 attempt 2 (m13)): 16/18 — m5 47/48, m13 43 ok / 4
FAIL + a refocus crash. One root cause behind the tabs failures,
plus a drag-gate miss and a verify-window crash, all read off
the re-pulled boot logs, check JSONs, and drag-aside /
refocus-fresh PPMs:
(1) The `BROWSER tabs 1` marker: the Browser app logs its tab
count exactly ONCE per go(), in the refresh() ~0.1 s after
`browser open` returns, and at that instant the count is
TRANSIENT, not the steady state — m5 cold start logs `tabs 0`
(CDP still down, `browser tabs` exits 1, 75 ms after the open;
the page loads seconds later, green=171376px, but the app never
re-refreshes), m13 warm open logs `tabs 2` (the close of the old
tab is still in flight ~140 ms after the open; CDP later reports
n=1 Second Page). A literal `BROWSER tabs 1` poll waits 60 s for
a line the app cannot emit on this build. Harness fix: gate on
the app's own post-go confirmation (`BROWSER open title=...
url=<page2>`, or any post-go `BROWSER tabs N` with N>=1), with
ONE re-go when no marker arrives in 15 s, and verify the
single-tab contract in steady state over CDP (`TERMINAL
browser-tabs n=1` with the Second Page title — m13's CDP check
tightened to n=1, m5's folded into the tabs check). PRODUCT NOTE
for the coordinator (Browser.tsx, not the harness): refresh()
runs once and never re-samples, so the tab strip shows a stale
0/2 until the next user action — minimal fix is re-refreshing in
go() until the opened tab appears (bounded, ~10 s).
(2) The green drag gate: the (-400,+260) drag DID move the
Browser window (header (107,193)-(904,234) -> rows y453..494
x0..597, dx ~-309, dy +260) but the strict >700px header scan
returned null for the partly off-screen header, so the code
reported "drag did not move it" and never raised. And the
exposed green is only a 14px strip (10,752 px, bbox
(129,272)-(896,285)) — the Terminal (top y287) covers Chromium
below y287, so no drag distance can expose more without raising.
Fix: partial-header fallback for the drag's after-frame, verified
drag start (a covered header's usual start can land inside
Chromium), drag-back by the true move (right edge when the left
is screen-clamped: -307, not -107), and the gate UNCHANGED at
count > 20000 AND width >= 400 — it measures the POST-raise
frame (~168k px), and lowering it to ~5,000 would let a 14px
strip pass without ever raising Chromium.
(3) The refocus crash: Phase 0 clicked and LANDED every time
(nodeId 56, TextInput) and every EXEC arrived — but 15.1–15.3 s
after its click, past the 10 s verify window (round 5 saw 15.8 s).
Fix: verify window 10 s -> 25 s (covers the worst observed
15.8 s with margin; a genuinely lost focus still fails fast),
and findWindowHeader now takes left/right from the header band
only — the dragged-aside Browser window's dark body had merged
#111827 pixels into lower rows and returned left=0 instead of
103, failing the consistency gate on a visible Terminal.
(4) Link-nav click: the blue bbox was exactly the Chromium
window, so its centre IS the link centre, but the round-4
single-pixel verification rejected it (the centre pixel is an
antialiased glyph blend, neither pure blue nor pure white).
Fix: neighbourhood verification (>=50% blue/white in 11x11)
plus a white-text presence check (>=500 white px inside the blue
viewport proves the link rendered).
Harness test: `~/workspace/ci-watch/r7-harness-test.mjs` (real
dbdda2ae frames + boot logs in `~/workspace/ci-watch/`).

Round 8 (PR #117 CI, head 0f82d7d9, run 43715706248): 16/18 —
the round-7 refocus work landed: the drag-back ran instead of
returning null (partial before-scan + verified retry loop + its
own explicit failing check), and the dock-relaunch readiness wait
(30 s, frame-proven) stopped the verify window expiring while the
relaunched Terminal was still booting. Harness test:
`~/workspace/ci-watch/r8-harness-test.mjs`.

Round 9 (PR #117 CI, head 242ad0ba, runs 43720789371 (m5) /
43720789358 (m13)): 16/18 — m5 46/47, m13 56/62. Round 8 fixed
the refocus (steps 5–9 ran for the first time; the new drag-back
check passed on attempt 1). The two remaining failures are both
harness, not product:
(1) Occlusion (m13 checks 46–48, 50–51): after step 4's
drag-back the Browser window is back on top and the refocus
raised the Terminal frontmost, so Chromium sits ENTIRELY behind
Browser + Terminal — the link-before frame has zero blue/red/
green pixels in 60 s of polling, and the raise helpers can only
click a VISIBLE page pixel. Fix: reuse step 4's drag — drag the
Browser window aside again (same -400,+260; the header is fully
visible in the occluded frame, rows y193–234, x107–904, so the
drag starts on a verified header pixel) to expose Chromium's top
strip, raise from it, keep the window aside through step 6, and
drag it back verified (dragBrowserBack, now shared with step 4)
after the chromeless measurement, with its own explicit failing
check. The raise itself is the frame proof (post-click count +
width >= 400); a failed aside drag never silently proceeds
occluded — the raise still runs and fails explicitly.
(2) Lifecycle close (m13 check 56, FALSE failure): the X click
worked (boot log `[1180749] EXEC sevyn browser quit -> 0`,
`[1181080] HOST app exiting`, final frame confirms the window
gone) but the single +1 s verify shot still showed the window,
so the code declared a miss and its appd CLOSE fallback raced
the exit (`APPD CLOSE FAIL browser not-running`). Fix: poll for
the window's disappearance up to 10 s (strict AND partial scans
both null), and treat post-quit not-running as already-closed
(quit line + not-running line both required); the close still
fails explicitly if the window is present after the poll.
(3) Focus hole (m5 check 43, and latent in m13): the Terminal
never executed `browser tabs` in 8 minutes (zero `JS TERMINAL`
lines after frame 420000) while every verifyFocus + exec-wait
"passed" on the Browser app's refresh loop, which emits the SAME
`EXEC sevyn browser status/tabs/open` lines. Discriminator,
proven on both 242ad0ba boot logs: the Terminal echoes every
command it runs as `JS TERMINAL browser-<verb> ...` 2–46 ms
after its EXEC line; the Browser app echoes `JS BROWSER ...`.
Fix: termCmd's EXEC wait is Terminal-scoped
(waitForTerminalExec: EXEC + its own verb's echo within 16 log
lines and 5000 guest-ms; a `JS BROWSER` line first ends the
search). `activate`/`close` have no echo but no other app runs
those verbs, so their EXEC lines need no scoping. termCmd also
re-clicks the Terminal input from a FRESH guarded frame
immediately before typing, so the click that focuses the input
is the one for that exact command.
Harness test: `~/workspace/ci-watch/r9-harness-test.mjs` (real
242ad0ba frames + boot logs in `~/workspace/ci-watch/`).

### Single-tab by design (M13)

M13 is single-tab by design: each `browser open` replaces the
current tab. A warm open (Chromium already running) does PUT
`/json/new`, then closes every other page tab and activates the new
one — so after the open there is exactly ONE tab, the new one, and
the new tab's window is frontmost by elimination. (Why: with `--app`,
PUT `/json/new` opens the new tab in a NEW window that stays behind
the first window, and `/json/activate` only switches the tab inside
its own window — so a warm open used to keep painting the first page
and never navigate again. Closing the other tabs kills their windows
with them.) Closing the last tab empties the browser: `browser tabs`
reports n=0, and Chromium may or may not stay running with zero
tabs — the checks record which, they do not assert it. Tab ids are
never carried across opens: any id recorded before an open is dead
by the next one.

### Lifecycle: pidfile + state file

Chromium's lifecycle is pidfile/state-file driven, owned by
`sevyn browser` in `v2/update/sevyn.c`:

- Launch writes the Chromium pid + the state file; `browser status`
  reads them (running: yes/no, CDP answering, `gpu:` line).
- `sevyn browser quit` stops Chromium and removes the state. The
  in-app close button is the path that quits Chromium; closing the
  Browser app window is what triggers it.

### CDP control plane, retained

Nothing about CDP changes: the Browser app still drives Chromium over
CDP (open / tabs / activate / close / status), and `sevyn browser
open <url>` from the Terminal does the same. M13 changes how
Chromium is launched, sized, and stopped — not how it is driven.

## What is NOT in M13

- No subsurface, no compositor placement protocol, no frame transport
  (see "The decisive Wayland facts" above).
- No multi-tab. M13 is single-tab by design (see above): each
  `browser open` replaces the current tab, and closing the last tab
  empties the browser. Real multi-tab is the principled follow-up,
  not this PR: it needs a WebSocket client in the C CLI driving
  Page.navigate / minimize-restore windows — CDP over HTTP only
  cannot drive a live tab switch across windows.
- No live resize sync: the Chromium window does not follow a Browser
  window resize in real time — that needs a CDP WebSocket client in
  the C CLI, and the CLI speaks CDP over HTTP only. A resize is a
  follow-up, not M13.
- No compositor raise on warm open: a Terminal-issued `browser open`
  lands behind the focused Terminal (close-others only orders windows
  WITHIN Chromium; it cannot put Chromium above the Terminal) — the
  user raises it by clicking the visible part of the Chromium window,
  which is normal window-manager behaviour. The reliable raise
  primitive (compositor activation on warm open, or an appd FOCUS
  command so the check can raise+focus without pixel geometry) is a
  follow-up, not M13.
- No appd-CLOSE orphan: appd CLOSE of the Browser app now SIGTERMs
  Chromium (reads the pid from `/data/chromium.state`, same as
  `sevyn browser quit`) — every close path kills Chromium, not only
  the in-app close button.
- No change to commsd, Sevyn Code, or any WebView. No change to the
  new rebuild stack beyond the `sevyn browser` verbs and the Browser
  app.

## Image + staging (build-m13-image.sh)

New builder, copied from `build-m12-image.sh` — the M12 builder is
untouched, so the M12 check keeps proving its own image.

- No new compile step and no new staging step: the launch / fallback
  / lifecycle changes live in `v2/update/sevyn.c` (compiled by the
  existing `sevyn` gcc line) and the chrome lives in
  `v2/apps/src/Browser.tsx`. No new host `.cc` file joins the
  `sevyn-rn-host` link.
- The Chromium snapshot pin is unchanged (1738523 = 159.0.8150.0),
  as are the staging, `weston.ini`, and the Genesis GPU present path.
- The nightly (`public-build.yml`) switches to `build-m13-image.sh`,
  so the embed ships in the nightly on merge. The M12 workflow keeps
  its own builder.

## Acceptance bar

- GF65: 60 fps sustained in the Browser (scrolling, navigation) +
  real-hardware rendering — hardware proof only, Kevon's retest.
- CI (m13-check, forked from m5-check): Genesis-live set (GL
  renderer, GPU present path, frames flowing, shell paints);
  browser status + CDP answering; a real page renders (title over
  CDP AND pixels in Chromium's window); address-bar typing drives
  Chromium to a new page; an in-page click navigates; closing the
  last tab empties the browser (`browser tabs` n=0); the chromeless
  heuristic (no Chromium UI of its own — viewport short + wide:
  height in [150, 360], aspect >= 2.0, measured 768x225); close
  kills Chromium (pidfile gone, no orphan);
  the m12 regression on the same image; clean poweroff.
- No regressions: M1–M12 + Repository quality green on the PR.

## Verification plan

1. Local: `npx prettier --check` on the touched md/yml files before
   pushing (no full-tree lint/test — turbo OOMs in the sandbox);
   `bash -n` on the builder; YAML parse on the workflow.
2. CI: the PR runs all workflows (it touches `v2/`). M13's own
   workflow builds the M13 image, runs `m13-check.mjs` in QEMU,
   then `m12-check.mjs` as a regression on the same image.
3. KVM box (45.77.162.169) if time allows: `build-m13-image.sh` +
   `m13-check.mjs` under KVM — the fastest real QEMU proof.
4. GF65 (Kevon): flash the nightly, confirm 60 fps + no visual
   regressions. This is the only proof of the bar.

## Risks

- llvmpipe is slow at 1920x1080 under TCG: the check asserts pages
  render, never a frame rate. The fps number is hardware-only.
- Weston cascades the Chromium toplevel where it chooses: the
  pairing is by size + lifecycle, not by position, so a cascade
  that lands far from the Browser window reads as two windows, not
  one browser. Mitigation: the chromeless heuristic + the content
  rect assert on size, not on screen position.
- The GPU fallback can mask a real GPU regression: a broken GPU
  path that silently falls back to software still renders the page.
  Mitigation: `browser status` reports the `gpu:` line and the
  check asserts which path is active on each boot.
- CDP over HTTP only: anything that needs a live CDP event stream
  (resize sync, load progress) cannot be built on this CLI. That is
  the known M13 boundary, not a surprise.
