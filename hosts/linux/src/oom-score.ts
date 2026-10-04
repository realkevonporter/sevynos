import { writeFileSync } from "node:fs";

/**
 * OOM-killer prioritization for the SevynOS session.
 *
 * Follows the Ubuntu 26.10 model: session-critical processes get a strongly
 * negative oom_score_adj so the kernel OOM killer picks them last, while
 * ordinary applications keep the default score and die first. Scores are
 * clamped to the kernel's [-1000, 1000] range; -1000 (unkillable) is never
 * used because a leaking session process must still be killable as a last
 * resort.
 */
export const OOM_SCORE_ADJ = {
  /** Genesis host, Wayland bridge, recovery-path terminal: die last. */
  SESSION_CRITICAL: -500,
  /** Ordinary applications: die before session processes under pressure. */
  DEFAULT: 0,
} as const;

const OOM_SCORE_ADJ_MIN = -1000;
const OOM_SCORE_ADJ_MAX = 1000;

/**
 * Application IDs that belong to the trusted session surface and must
 * survive memory pressure ahead of ordinary apps. The terminal is the
 * system recovery path, so it is protected alongside the session host.
 */
const OOM_PROTECTED_APPLICATION_IDS: ReadonlySet<string> = new Set([
  "org.sevynos.terminal",
]);

/** OOM score for a freshly spawned application process. */
export function oomScoreAdjForApplication(applicationId: string): number {
  return OOM_PROTECTED_APPLICATION_IDS.has(applicationId)
    ? OOM_SCORE_ADJ.SESSION_CRITICAL
    : OOM_SCORE_ADJ.DEFAULT;
}

/**
 * Write an oom_score_adj value for a process. Never throws: returns false
 * when the write is not possible (non-Linux host, missing /proc entry, or
 * insufficient privilege to lower the score). Callers should log and
 * continue; protection is best-effort and must never break process startup.
 */
export function setOomScoreAdj(pid: number, score: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const clamped = Math.max(
    OOM_SCORE_ADJ_MIN,
    Math.min(OOM_SCORE_ADJ_MAX, Math.trunc(score)),
  );
  try {
    // Synchronous: the score must be in place before the child can be
    // OOM-scored, and this runs once per process spawn.
    writeFileSync(`/proc/${String(pid)}/oom_score_adj`, `${String(clamped)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Protect the current process (the Genesis session host) from the OOM
 * killer. Best-effort; returns false when not applicable.
 */
export function protectCurrentProcessFromOomKiller(): boolean {
  return setOomScoreAdj(process.pid, OOM_SCORE_ADJ.SESSION_CRITICAL);
}
