import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { QmpClient } from "./qmp-client.mjs";

const socket = resolve(import.meta.dirname, "build/qmp.sock");
await access(socket);
const client = await QmpClient.connect(socket);
await client.command("system_powerdown");
client.close();
console.log("Requested controlled SevynOS guest shutdown.");
