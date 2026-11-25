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
// Run: node v2/image/mock-muse.js  (or the code-server node binary
// in the guest, as the init snippet does).
const http = require("node:http");

const PORT = 7071;

// The canned reply: the model "decides" to launch the Files app.
// The arguments are a JSON string, exactly as the real Chat
// Completions API returns them.
const REPLY = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "launch",
              arguments: JSON.stringify({ id: "files" }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
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
    try {
      model = JSON.parse(body).model || "(no model)";
    } catch {}
    console.log(`MUSE-MOCK ${req.method} ${req.url} model=${model}`);
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const data = JSON.stringify(REPLY);
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
