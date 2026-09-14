globalThis.__sevynReceiveHostMessage = function receiveHostMessage(message) {
  const parsed = JSON.parse(message);
  __sevynPostMessage(
    JSON.stringify({
      type: "echo",
      engine: __sevynEngine(),
      value: parsed.value,
    }),
  );
};

__sevynPostMessage(JSON.stringify({ type: "ready", engine: __sevynEngine() }));
