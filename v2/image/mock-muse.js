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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let model = "(unparsed)";
    let task = "";
    try {
      const parsed = JSON.parse(body);
      model = parsed.model || "(no model)";
      const userMsg = (parsed.messages || []).find((m) => m.role === "user");
      task = (userMsg && userMsg.content) || "";
    } catch {}
    console.log(`MUSE-MOCK ${req.method} ${req.url} model=${model}`);
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    // The session task gets the session sequence (one reply per
    // request, then no-tools); every other task gets LAUNCH. The
    // sequence resets once exhausted: the m4.5 check runs the same
    // "session fix" task twice (Terminal muse-ai session, then the
    // relay session), and a single-use script would hand the relay
    // session no-tools on its first request (allowed=0 — the §9
    // failure on PR #167's fix head). Resetting on exhaustion keeps
    // each session's sequence identical.
    let reply;
    if (task.includes("session fix")) {
      if (sessionCount < SESSION_REPLIES.length) {
        reply = SESSION_REPLIES[sessionCount++];
      } else {
        reply = NO_TOOLS_REPLY;
        sessionCount = 0;
      }
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
