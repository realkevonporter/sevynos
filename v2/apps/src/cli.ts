// SevynOS v2 M4 — shared `sevyn` CLI helpers for the system apps.
//
// Sevyn.exec returns "<exit-code>\n<output>" (or an "ERR ..." string
// with no newline when the call is refused). These helpers parse that
// shape so each app reads the same way.
export function runCli(cmdline: string): { code: number; out: string } {
  const raw = Sevyn.exec(cmdline);
  const nl = raw.indexOf("\n");
  if (nl < 0) return { code: -1, out: raw };
  const code = parseInt(raw.slice(0, nl), 10);
  return { code: Number.isNaN(code) ? -1 : code, out: raw.slice(nl + 1) };
}

// Same shape as runCli, off the JS thread (M9 wifi scan/connect:
// a scan waits ~4 s and association ~10 s — a synchronous exec
// would freeze the UI for that long). The host's execAsync returns
// a Promise of the same "<exit-code>\n<output>" string.
export async function runCliAsync(
  cmdline: string,
): Promise<{ code: number; out: string }> {
  const raw = await Sevyn.execAsync(cmdline);
  const nl = raw.indexOf("\n");
  if (nl < 0) return { code: -1, out: raw };
  const code = parseInt(raw.slice(0, nl), 10);
  return { code: Number.isNaN(code) ? -1 : code, out: raw.slice(nl + 1) };
}

// First `key=value` or `key: value` field in CLI output (update
// status prints channel=nightly; code status prints running: yes).
export function parseField(out: string, key: string): string | null {
  const m = out.match(new RegExp(key + "[=:][ ]?([^\\s]+)"));
  return m ? m[1] : null;
}
