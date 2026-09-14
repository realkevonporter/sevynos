import { createConnection } from "node:net";

export class QmpClient {
  #socket;
  #buffer = "";
  #sequence = 0;
  #pending = new Map();

  static connect(path) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("connect", () => {
        const client = new QmpClient(socket);
        client.command("qmp_capabilities").then(() => resolve(client), reject);
      });
    });
  }

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", (error) => this.#rejectPending(error));
    socket.on("close", () =>
      this.#rejectPending(
        new Error("QMP connection closed before the command completed."),
      ),
    );
  }

  command(execute, argumentsValue) {
    this.#sequence += 1;
    const id = `qmp-${String(this.#sequence)}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(
        `${JSON.stringify({ execute, ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }), id })}\n`,
      );
    });
  }

  close() {
    this.#socket.end();
  }

  #receive(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const boundary = this.#buffer.indexOf("\n");
      if (boundary < 0) return;
      const line = this.#buffer.slice(0, boundary).trim();
      this.#buffer = this.#buffer.slice(boundary + 1);
      if (line === "") continue;
      const message = JSON.parse(line);
      if (typeof message.id !== "string") continue;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.return);
      else pending.reject(new Error(message.error.desc ?? "QMP command failed."));
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
