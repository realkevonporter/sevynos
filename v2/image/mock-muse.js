// Mock Muse API (P0): a Chat Completions test double for the m4.5
// check, never a system service. It serves a canned reply on
// 127.0.0.1:7071 — one tool call, LAUNCH files — so the check can
// prove the muse-ai backend really calls the API (over HTTPS in
// production, plain HTTP on loopback here) and the daemon really
// executes the action it returns. It starts only when the kernel
// cmdline carries sevyn.mockmuse=1 (see build-m4.5-image.sh /
// build-m5-image.sh), and it logs every request to the console so
// the harness can grep the serial log for the wire.
//
// P1: the mock is task-aware. A task that asks to "session fix" the
// settings gets a session sequence — read the settings, try to
// write a fix (denied under the standard grant, which has no
// file.write), read again to re-check, then stop — so the check can
// prove the session protocol (read -> fix -> re-check) and the
// grant gate in the guest. Every other task gets the LAUNCH reply,
// so the P0 ASK check is unaffected.
//
// Phase 3 (B1): the mock routes on the LAST user message (the task
// when history is present) and logs the message count + roles, so
// the check can prove the history reached the API. A request that
// already carries a tool result gets no-tools (the model has seen
// the outcome). The CHAT turns get prose answers — "list all
// installed apps" (15 apps) and "which ones can play music" (Just
// Music, which only makes sense if the model saw the first turn) —
// and "launch the Music app" gets a Music LAUNCH.
const http = require("node:http");

const PORT = 7071;

// Build one tool-call reply, exactly as the real Chat Completions
// API returns it (arguments are a JSON string).
function toolReply(id, name, args) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

// The canned reply: the model "decides" to launch the Files app.
const LAUNCH_REPLY = toolReply("call_1", "launch", { id: "files" });

// The session sequence (P1): read, write, re-read, then stop. The
// write targets /data/settings.json — a real guest file — but the
// standard grant has no file.write, so the daemon denies it and
// the file is untouched; the session still proves the loop ran.
const SESSION_REPLIES = [
  toolReply("call_1", "read", { path: "/data/settings.json" }),
  toolReply("call_2", "write", {
    path: "/data/settings.json",
    content: "volume=99\n",
  }),
  toolReply("call_3", "read", { path: "/data/settings.json" }),
];
let sessionCount = 0;

// No more tool calls: the agent loop ends (and the session ends).
const NO_TOOLS_REPLY = {
  choices: [
    {
      message: { role: "assistant", content: "done" },
      finish_reason: "stop",
    },
  ],
};

// The CHAT replies (phase 3, B1): the model answers in prose, and
// the daemon carries the prose as the turn's TEXT. The two prose
// answers are unique so the guest check can tell them apart — and
// the second one only makes sense if the model saw the first turn
// (memory across turns).
function proseReply(content) {
  return {
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}
const PROSE_15_APPS_REPLY = proseReply(
  "You have 15 apps installed — Terminal, Files, Music, and 12 more.",
);
const PROSE_JUST_MUSIC_REPLY = proseReply(
  "Just Music — it’s the only audio player installed.",
);

// The CHAT launch reply: the model "decides" to launch Music.
const LAUNCH_MUSIC_REPLY = toolReply("call_1", "launch", { id: "music" });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let model = "(unparsed)";
    let task = "";
    let messageCount = 0;
    let roles = "";
    let hasToolResult = false;
    try {
      const parsed = JSON.parse(body);
      model = parsed.model || "(no model)";
      const messages = parsed.messages || [];
      messageCount = messages.length;
      roles = messages.map((m) => m.role).join(",");
      hasToolResult = messages.some((m) => m.role === "tool");
      // Route on the LAST user message: the first is the task when
      // there is no history, the last is the task when there is —
      // so P0/P1 (no history) route exactly as before.
      const userMsgs = messages.filter((m) => m.role === "user");
      const lastUser = userMsgs[userMsgs.length - 1];
      task = (lastUser && lastUser.content) || "";
    } catch {}
    console.log(
      `MUSE-MOCK ${req.method} ${req.url} model=${model} ` +
        `messages=${messageCount} roles=${roles}`,
    );
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    // Routing (phase 3, B1), in order:
    // 1. The session task gets the session sequence (one reply per
    //    request, then no-tools); every other task gets LAUNCH. The
    //    sequence resets once exhausted: the m4.5 check runs the same
    //    "session fix" task twice (Terminal muse-ai session, then the
    //    relay session), and a single-use script would hand the relay
    //    session no-tools on its first request (allowed=0 — the §9
    //    failure on PR #167's fix head). Resetting on exhaustion keeps
    //    each session's sequence identical.
    // 2. A request that already carries a tool result gets
    //    no-tools: the model has seen the outcome, so re-issuing
    //    LAUNCH every round (until the cap) would double-execute.
    //    ASK mode never reaches this — it ends the loop after the
    //    first tool call — so P0 is unaffected.
    // 3. The CHAT prose branches (turn 1 lists, turn 2 remembers)
    //    and the CHAT music launch (turn 3).
    // 4. Everything else gets the LAUNCH reply (P0 ASK).
    let reply;
    if (task.includes("session fix")) {
      if (sessionCount < SESSION_REPLIES.length) {
        reply = SESSION_REPLIES[sessionCount++];
      } else {
        reply = NO_TOOLS_REPLY;
        sessionCount = 0;
      }
    } else if (hasToolResult) {
      reply = NO_TOOLS_REPLY;
    } else if (task.includes("launch the Music app")) {
      reply = LAUNCH_MUSIC_REPLY;
    } else if (task.includes("which ones can play music")) {
      reply = PROSE_JUST_MUSIC_REPLY;
    } else if (task.includes("list all installed apps")) {
      reply = PROSE_15_APPS_REPLY;
    } else {
      reply = LAUNCH_REPLY;
    }
    const data = JSON.stringify(reply);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MUSE-MOCK listening on 127.0.0.1:${PORT}`);
});
