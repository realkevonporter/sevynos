import { rm } from "node:fs/promises";
import { resolve } from "node:path";
await rm(resolve(import.meta.dirname, "build"), { recursive: true, force: true });
console.log("QEMU development build removed.");
