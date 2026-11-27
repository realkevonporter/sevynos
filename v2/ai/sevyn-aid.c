/* SevynOS v2 M4.5 — the AI daemon (sevyn-aid).
 *
 * The AI connector, baked into the OS. ANY AI plugs in via this
 * daemon and drives the whole system — no single-AI lock-in
 * (openness lock). The AI acts through the system's permission
 * model, never around it: every action a backend proposes is checked
 * against the AI permission grant before it runs, and anything
 * outside the grant is refused and logged, never executed.
 *
 * Backends are plain executables in the backends directory, one per
 * AI. A backend speaks a tiny line protocol on stdin/stdout: it
 * reads one task line, prints action lines, ends with END. The
 * daemon spawns the selected backend per ASK, so swapping the AI is
 * a SELECT — no code change, no rebuild, no reboot. Two stub
 * backends ship in the image (echo-ai, plan-ai); they are simple
 * local scripts for the proof — the point is the swap works through
 * the same connector, not shipping a real model.
 *
 * Socket protocol (/run/sevyn-ai.sock, one line in, one line out):
 *   PING              -> OK pong
 *   LIST              -> OK selected=<id> backends=<csv>
 *   SELECT <id>       -> OK selected <id> / ERR unknown backend <id>
 *   STATUS            -> OK selected=<id> backends=<csv> grant=<csv>
 *                        god_mode=<on|off>
 *   RELOAD            -> OK grant reloaded / ERR (old grant kept)
 *   ASK <task...>     -> OK backend=<id> allowed=<n> denied=<m>
 *                        failed=<k>
 *   SESSION <task...> -> the session protocol (P1, phase 2, §1.4.1):
 *                        the backend emits ONE action, the daemon
 *                        executes it (grant-checked) and returns the
 *                        result to the backend, which decides the
 *                        next action. The daemon writes "SESSION"
 *                        then the task line to the backend's stdin;
 *                        after each action it writes back
 *                        "RESULT OK|DENIED|FAILED <detail>".
 *                        The backend ends with END. The per-action
 *                        budget (D8) replaces the single-shot
 *                        timeout: each action gets the backend's
 *                        full timeout from its .limits file
 *                        (muse-ai 300 s, others 5 s), and the total
 *                        actions are capped by its max_actions
 *                        (muse-ai 64, others 32). A timeout with
 *                        partial progress replies OK with the counts
 *                        so far; a timeout with no progress is ERR.
 * The harness control serial (/dev/ttyS4) takes the same verbs; its
 * replies go to the console as AID log lines (like appd's ttyS2).
 * SIGHUP also reloads the grant. A failed reload keeps the old
 * grant — reload never fails open.
 *
 * Backend action lines (one per line, then END):
 *   LAUNCH <id>       app.launch   -> appd LAUNCH
 *   CLOSE <id>        app.close    -> appd CLOSE
 *   LIST              app.list     -> appd LIST (count logged)
 *   SET <key> <value> status.set   -> statusd SET
 *   READ <path>       state.read   -> bounded read, logged (no grant
 *                                    needed: reads change nothing)
 *   EXEC <verb...>    cli.exec     -> runs `sevyn` CLI verbs only,
 *                                    never a shell (D5)
 *   WRITE <path> <content> file.write -> bounded write (P1, §1.4.3):
 *                                    only under /data/ or
 *                                    /var/lib/sevyn/, never the
 *                                    pristine bundles; the previous
 *                                    copy is kept as <path>.sevyn-bak;
 *                                    content uses \n escapes (one
 *                                    action line). Grant-checked.
 *   UPDATE [apply]    system.update -> check/apply via the existing
 *                                    updater (P1): UPDATE runs
 *                                    `sevyn update check`; UPDATE
 *                                    apply requests the apply (the
 *                                    device reboots when it lands).
 *                                    God-mode-only by grant (the
 *                                    standard grant has no
 *                                    system.update).
 *   UNINSTALL <id>    app.uninstall (P2, god mode only) -> the
 *                                    registry removal path, with the
 *                                    protected-apps guard (shell +
 *                                    terminal refuse, in any mode)
 *   INSTALL <path>    app.install   (P2, god mode only) -> the
 *                                    .sevyn bundle install path
 *   REBOOT            system.reboot (P2, god mode only) -> the
 *                                    existing `sevyn reboot` path
 *                                    (statusd asks init; the device
 *                                    goes down a second later)
 * Unknown verbs are refused as unknown.
 *
 * God mode (P2, design §2): the standard grant plus every
 * permission the standard grant refuses, as a SEPARATE grant file
 * (/data/ai/grant-god.json) plus a marker (/data/ai/god-mode.json),
 * both on the persistent data disk, default OFF, opt-in only. The
 * daemon loads the god grant only when the marker says god_mode is
 * true AND the god grant parses; a missing or unparseable god grant
 * falls back to the standard grant and logs
 * "AID god grant invalid, standard grant in force". The marker
 * survives a reboot (D2): at startup the daemon logs
 * "AID god mode active" when it is on, never silently. The AI
 * cannot enable god mode — there is no GOD verb and no backend
 * action reaches it; only `sevyn ai god` (CLI) and the Settings
 * toggle, both human-operated, write the marker. Every action the
 * AI takes — allowed, denied, failed — is appended to the audit
 * log (/data/logs/ai-audit.log), one line per action, plus the
 * god-mode enable/disable transitions. An action is refused when
 * the audit log cannot be written (fail-closed); the log rotates
 * at 1 MB to ai-audit.log.1. The daemon also SETs the statusd key
 * ai.god_mode (on/off) on every transition, so the shell's status
 * tray can show the mode mark.
 *
 * Per-backend limits (P0): a backend may ship a `<id>.limits` file
 * next to itself (timeout=<s>, max_actions=<n>); muse-ai ships
 * 300 s / 64. Every other backend keeps 5 s / 32. The ASK task line
 * is 16 KiB; backend action lines stay 2,048 bytes.
 *
 * Grant (/usr/share/sevyn/ai/grant.json):
 *   {"permissions": ["app.launch", "app.close", "app.list",
 *                    "status.set"]}
 * A missing or unparseable grant is fatal: the daemon refuses to
 * start rather than run an AI with an unknown grant (fail-closed).
 * God mode (P2) is a second grant, /data/ai/grant-god.json, plus
 * the marker /data/ai/god-mode.json — see the god-mode section
 * above. A broken god grant degrades to the standard grant, never
 * to "no grant"; a broken standard grant still refuses to start,
 * god mode or not.
 *
 * Selection is persisted to /data/ai-selected.json (falling back to
 * /run/ai-selected.json when there is no data disk) so the user's
 * choice survives a reboot. Settings changes it through
 * `sevyn ai select` (same CLI the Terminal uses).
 *
 * Env overrides (host tests): SEVYN_AI_SOCK, SEVYN_AI_CTL,
 * SEVYN_AI_BACKENDS_DIR, SEVYN_AI_GRANT, SEVYN_AI_SELECTED,
 * SEVYN_AI_APPD_SOCK, SEVYN_AI_STATUS_SOCK, SEVYN_AI_CLI (the
 * `sevyn` binary EXEC runs; default /usr/local/bin/sevyn),
 * SEVYN_AI_READ_ROOT (test-only: the one directory READ may touch,
 * replacing /data/ + /var/lib/sevyn/), SEVYN_AI_WRITE_ROOT
 * (test-only: the one directory WRITE may touch, same replacement),
 * SEVYN_AI_GOD_GRANT, SEVYN_AI_GOD_MARKER, SEVYN_AI_AUDIT_LOG
 * (test-only: the god-mode grant, marker, and audit log paths),
 * SEVYN_AI_RELAY_AGENT_MARKER (the relay agent-enable marker;
 * default /data/ai/relay-agent.json).
 *
 * Build: gcc, libc only (+ the M3 JSON parser for the grant).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "json.h"

#define DEFAULT_SOCK "/run/sevyn-ai.sock"
#define DEFAULT_CTL "/dev/ttyS4"
#define DEFAULT_BACKENDS_DIR "/usr/share/sevyn/ai/backends"
#define DEFAULT_GRANT "/usr/share/sevyn/ai/grant.json"
#define DEFAULT_SELECTED "/data/ai-selected.json"
#define FALLBACK_SELECTED "/run/ai-selected.json"
#define DEFAULT_APPD_SOCK "/run/sevyn-apps.sock"
#define DEFAULT_STATUS_SOCK "/run/sevyn-status.sock"

#define LINE_CAP 2048
/* A backend ERR chatter line stashed for the reply (muse-ai's longest
 * is "Muse API unreachable: " plus a <=255-byte transport error).
 * The reply carries it as error=<text> so a 0/0/0 names its cause. */
#define BACKEND_ERR_CAP 512
/* The ASK task line (P0): a real agent task plus attached context
 * does not fit in 2,048 bytes. Backend action lines stay LINE_CAP
 * (actions are short by construction); only the task-carrying
 * buffers grow to TASK_CAP. */
#define TASK_CAP 16384
#define MAX_CLIENTS 16
#define MAX_BACKENDS 32
#define MAX_ACTIONS 32
#define BACKEND_TIMEOUT_S 5
/* Per-backend limits (P0): the defaults above are right for keyword
 * stubs and wrong for a model round-trip. A backend may ship a
 * `<id>.limits` file next to itself (timeout=<s>, max_actions=<n>);
 * the daemon reads it when the backend runs. Clamped to sane
 * bounds, so a bad limits file cannot remove the timeout. */
#define LIMITS_TIMEOUT_MAX_S 3600
#define LIMITS_ACTIONS_MAX 256
/* READ executor (P0): one read is capped, so a backend cannot pull
 * an unbounded file into the audit trail. */
#define READ_CAP 65536
/* EXEC executor (P0): runs `sevyn` CLI verbs only, never a shell
 * (D5). The CLI path has a host-test override. */
#define DEFAULT_CLI "/usr/local/bin/sevyn"
/* WRITE executor (P1, §1.4.3): a file the AI replaces must be one
 * it could have fully read, so the existing file is capped at the
 * READ cap — replacing a larger file would destroy content the
 * backend never saw. The wire content is bounded by the action line
 * (LINE_CAP); newlines ride as \n escapes. */
#define WRITE_EXISTING_CAP READ_CAP
/* UPDATE executor (P1): the check waits like an EXEC (30 s); the
 * apply is requested, not awaited — the CLI child downloads and the
 * device reboots when it lands, so the daemon only waits long
 * enough to catch an immediate failure. */
#define UPDATE_CHECK_TIMEOUT_S 30
#define UPDATE_APPLY_WAIT_S 5
/* Pristine stock bundles: the offline reinstall source, never
 * writable by the AI in any mode (design §3.5). */
#define PRISTINE_PREFIX "/usr/share/sevyn/pristine/"
/* God mode (P2, design §2.4): the god grant + marker live on the
 * persistent data disk, never in the image. The audit log is the
 * dedicated, append-only trail (§2.5); it rotates at 1 MB. */
#define DEFAULT_GOD_GRANT "/data/ai/grant-god.json"
#define DEFAULT_GOD_MARKER "/data/ai/god-mode.json"
#define DEFAULT_AUDIT_LOG "/data/logs/ai-audit.log"
#define AUDIT_ROTATE_BYTES (1024 * 1024)
/* The statusd key the daemon SETs on every god-mode transition, so
 * the shell's status tray can show the mode mark (D1). */
#define GOD_MODE_STATUS_KEY "ai.god_mode"
/* AI relay (Phase 2, design §5): the agent-enable marker — its
 * existence at boot means the relay is enabled for this boot — and
 * the statusd key the daemon SETs on relay transitions (off/idle/on)
 * so the tray can show the live-session mark. The daemon never SETs
 * "off": the CLI sets it on disable, and statusd's default is off. */
#define DEFAULT_RELAY_AGENT_MARKER "/data/ai/relay-agent.json"
#define RELAY_STATUS_KEY "ai.relay"
/* REBOOT executor (P2): `sevyn reboot` asks statusd and exits 0
 * once the request is sent; the 30 s bound is the same as EXEC, so
 * a wedged CLI cannot stall the daemon. */
#define REBOOT_TIMEOUT_S 30

static const char *g_sock_path;
static const char *g_ctl_path;
static const char *g_backends_dir;
static const char *g_grant_path;
static const char *g_selected_path;
static const char *g_appd_sock;
static const char *g_status_sock;
static const char *g_cli_path;
/* God mode (P2): the runtime god grant, the marker, and the audit
 * log. Env-overridable for the host tests; the production defaults
 * are the /data paths above. */
static const char *g_god_grant_path;
static const char *g_god_marker_path;
static const char *g_audit_path;
/* AI relay (Phase 2): the agent-enable marker path (env-overridable
 * for the host tests; the production default is the /data path
 * above) and the daemon's own view of the relay state — what STATUS
 * reports and what the tray reads via statusd. "off" is the default;
 * "idle" once the marker exists at boot; "on" while a relay SESSION
 * is live. */
static const char *g_relay_agent_marker_path;
static const char *g_relay = "off";
/* 1 while the god grant is the live grant, 0 while the standard
 * grant governs. Set only by eval_god_mode(), never by a backend. */
static int g_god_mode = 0;

/* Forward: defined after status_set() (it SETs the statusd key on
 * transitions); reload_grant() calls it, so it is declared here. */
static int eval_god_mode(void);
/* Test-only read root (SEVYN_AI_READ_ROOT): when set, READ may only
 * touch paths under it (the host test cannot write /data). Unset in
 * production, where the /data/ + /var/lib/sevyn/ roots apply. */
static const char *g_read_root;
/* Test-only write root (SEVYN_AI_WRITE_ROOT): when set, WRITE may
 * only touch paths under it (the host test cannot write /data).
 * Unset in production, where the /data/ + /var/lib/sevyn/ roots
 * apply. The pristine exclusion holds either way. */
static const char *g_write_root;
static int g_console_fd = -1;
static volatile sig_atomic_t g_stop = 0;
/* Set by the SIGHUP handler; the main loop reloads the grant when
 * it sees this (P0 grant reload). */
static volatile sig_atomic_t g_reload = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static void on_sighup(int sig)
{
    (void)sig;
    g_reload = 1;
}

static const char *env_or(const char *name, const char *dflt)
{
    const char *v = getenv(name);
    return (v && *v) ? v : dflt;
}

/* Retrying console writer (same pattern as statusd / appd). */
static void write_all_console(const char *buf, size_t n)
{
    size_t off = 0;
    int tries = 0;
    while (off < n && tries < 50) {
        ssize_t w = write(g_console_fd, buf + off, n - off);
        if (w > 0) {
            off += (size_t)w;
            continue;
        }
        if (w < 0 && errno != EAGAIN && errno != EINTR)
            break;
        struct pollfd pfd = { .fd = g_console_fd, .events = POLLOUT };
        (void)!poll(&pfd, 1, 100);
        tries++;
    }
}

static void log_line(const char *fmt, ...)
{
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    if (g_console_fd >= 0)
        write_all_console(buf, (size_t)n);
    (void)!fwrite(buf, 1, (size_t)n, stderr);
}

/* Read a whole file (up to cap bytes). Returns malloc'd text or NULL. */
static char *read_file_cap(const char *path, size_t cap)
{
    FILE *f = fopen(path, "r");
    if (!f)
        return NULL;
    char *buf = malloc(cap + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, cap, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

/* Atomic write: tmp file in the same directory + rename. */
static int write_file_atomic(const char *path, const char *data)
{
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f)
        return -1;
    size_t len = strlen(data);
    if (fwrite(data, 1, len, f) != len) {
        fclose(f);
        unlink(tmp);
        return -1;
    }
    if (fclose(f) != 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, path) != 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* audit log (P2, design §2.5)                                         */
/* ------------------------------------------------------------------ */

/* The dedicated, append-only audit trail: one line per action the
 * AI takes (allowed, denied, failed) plus the god-mode
 * enable/disable transitions. The daemon owns the file and appends
 * to it; no backend verb reaches it. An action is refused when the
 * log cannot be written (fail-closed) — see audit_probe() in
 * run_one_action. The log rotates at 1 MB to <path>.1. */

/* UTC ISO-8601 timestamp, "2026-11-25T16:30:00Z". */
static void audit_timestamp(char *out, size_t cap)
{
    time_t now = time(NULL);
    struct tm tmv;
    if (gmtime_r(&now, &tmv) == NULL) {
        snprintf(out, cap, "1970-01-01T00:00:00Z");
        return;
    }
    strftime(out, cap, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

/* Create the audit log's parent directory (best-effort: the probe
 * below is what decides writability). */
static void audit_mkdir_parent(void)
{
    char dir[4000];
    const char *slash = strrchr(g_audit_path, '/');
    if (!slash || slash == g_audit_path)
        return;
    size_t n = (size_t)(slash - g_audit_path);
    if (n >= sizeof(dir))
        return;
    memcpy(dir, g_audit_path, n);
    dir[n] = '\0';
    /* mkdir -p by hand: the parent of /data/logs is /data, which
     * exists on a real device; the loop covers a host-test tmp dir
     * whose parents may not. */
    for (char *p = dir + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(dir, 0755);
            *p = '/';
        }
    }
    mkdir(dir, 0755);
}

/* Rotate the log when it passes the cap: <path> becomes <path>.1
 * (the previous .1 is dropped). Best-effort — a failed rotation
 * never fails the action; the append below still runs. */
static void audit_rotate_if_needed(void)
{
    struct stat st;
    if (stat(g_audit_path, &st) != 0)
        return;
    if (!S_ISREG(st.st_mode) || st.st_size <= (off_t)AUDIT_ROTATE_BYTES)
        return;
    char old[4096];
    size_t n = strlen(g_audit_path);
    if (n + 3 > sizeof(old))
        return;
    memcpy(old, g_audit_path, n);
    memcpy(old + n, ".1", 3);
    unlink(old);
    rename(g_audit_path, old);
}

/* Prove the audit log is writable without writing a line: open it
 * in append mode (creating it and its parent first) and close it.
 * Returns 0 when writable, -1 when not. run_one_action calls this
 * BEFORE executing anything, so a broken log refuses the action
 * instead of letting it run unlogged (fail-closed). */
static int audit_probe(void)
{
    audit_mkdir_parent();
    audit_rotate_if_needed();
    int fd = open(g_audit_path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd < 0)
        return -1;
    close(fd);
    return 0;
}

/* Append one audit line. Returns 0 on success, -1 when the line
 * could not be written. The caller has already probed, so a failure
 * here is a race (disk full mid-action) — it is logged to the
 * console, but the action's outcome stands (it already ran).
 *
 * Phase 2 relay (design §4.4): via_relay marks relay-driven
 * actions with " via=relay" after god_mode — additive, so on-device
 * lines (via_relay 0) are byte-identical to before and existing
 * tooling keeps working. */
static int audit_append(const char *actor, const char *action_line,
                        const char *result, const char *detail,
                        int via_relay)
{
    char ts[32];
    audit_timestamp(ts, sizeof(ts));
    char line[2048];
    int n = snprintf(line, sizeof(line), "%s %s god_mode=%s%s %s %s %s\n",
                     ts, actor, g_god_mode ? "on" : "off",
                     via_relay ? " via=relay" : "", action_line,
                     result, detail ? detail : "");
    if (n < 0)
        return -1;
    if ((size_t)n >= sizeof(line))
        n = (int)sizeof(line) - 1;
    audit_rotate_if_needed();
    int fd = open(g_audit_path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd < 0)
        return -1;
    size_t off = 0;
    while (off < (size_t)n) {
        ssize_t w = write(fd, line + off, (size_t)n - off);
        if (w <= 0)
            break;
        off += (size_t)w;
    }
    close(fd);
    return off == (size_t)n ? 0 : -1;
}

/* ------------------------------------------------------------------ */
/* grant                                                               */
/* ------------------------------------------------------------------ */

/* The AI permission grant: the action permissions the connector
 * allows. Anything not listed here is refused, never executed. */
static char **g_grant = NULL;
static size_t g_ngrant = 0;

static int grant_has(const char *perm)
{
    for (size_t i = 0; i < g_ngrant; i++)
        if (strcmp(g_grant[i], perm) == 0)
            return 1;
    return 0;
}

/* Parse a grant file into a fresh permissions array (the caller
 * owns it). Returns 0 on success, -1 with a one-line reason in err.
 * The live grant is never touched by this helper, so a failed reload
 * cannot clobber it — reload never fails open. */
static int parse_grant_file(const char *path, char ***out,
                            size_t *nout, char *err, size_t errcap)
{
    char *text = read_file_cap(path, 65536);
    if (!text) {
        snprintf(err, errcap, "cannot read grant %s: %s", path,
                 strerror(errno));
        return -1;
    }
    char jerr[256];
    jval_t *root = json_parse(text, jerr, sizeof(jerr));
    if (!root) {
        snprintf(err, errcap, "grant %s is not valid JSON: %s", path,
                 jerr);
        free(text);
        return -1;
    }
    const jval_t *perms = json_obj_get(root, "permissions");
    if (!perms || perms->type != J_ARR) {
        snprintf(err, errcap, "grant %s has no permissions array",
                 path);
        json_free(root);
        free(text);
        return -1;
    }
    size_t n = json_arr_len(perms);
    char **grant = calloc(n ? n : 1, sizeof(char *));
    if (!grant) {
        snprintf(err, errcap, "out of memory");
        json_free(root);
        free(text);
        return -1;
    }
    size_t count = 0;
    for (size_t i = 0; i < n; i++) {
        const char *s = json_str(json_arr_get(perms, i));
        if (!s) {
            snprintf(err, errcap,
                     "grant %s has a non-string permission", path);
            for (size_t j = 0; j < count; j++)
                free(grant[j]);
            free(grant);
            json_free(root);
            free(text);
            return -1;
        }
        grant[count] = strdup(s);
        if (!grant[count]) {
            snprintf(err, errcap, "out of memory");
            for (size_t j = 0; j < count; j++)
                free(grant[j]);
            free(grant);
            json_free(root);
            free(text);
            return -1;
        }
        count++;
    }
    json_free(root);
    free(text);
    *out = grant;
    *nout = count;
    return 0;
}

static void free_grant(char **grant, size_t n)
{
    if (!grant)
        return;
    for (size_t i = 0; i < n; i++)
        free(grant[i]);
    free(grant);
}

/* Load the grant JSON: {"permissions": [...]}. Fatal on any failure
 * (missing file, bad JSON, wrong shape) — fail closed. */
static int load_grant(void)
{
    char err[256];
    char **grant = NULL;
    size_t n = 0;
    if (parse_grant_file(g_grant_path, &grant, &n, err, sizeof(err)) != 0) {
        log_line("AID fatal: %s", err);
        return -1;
    }
    g_grant = grant;
    g_ngrant = n;
    log_line("AID grant loaded (%zu permissions)", g_ngrant);
    return 0;
}

/* Re-read the grant file and swap it in, so god mode can switch on
 * and off without a daemon restart (P0). A failed reload keeps the
 * old grant and logs it — reload never fails open. Returns 0 when
 * the new grant is live, -1 when the old one was kept. The standard
 * grant is always re-read first (it is the fallback); eval_god_mode
 * then decides whether the live grant is the standard or the god
 * one, from the marker. */
static int reload_grant(void)
{
    char err[256];
    char **grant = NULL;
    size_t n = 0;
    if (parse_grant_file(g_grant_path, &grant, &n, err, sizeof(err)) != 0) {
        log_line("AID grant reload failed: %s (keeping old grant)",
                 err);
        return -1;
    }
    free_grant(g_grant, g_ngrant);
    g_grant = grant;
    g_ngrant = n;
    log_line("AID grant reloaded (%zu permissions)", g_ngrant);
    /* The live grant may be the god one (or fall back to this
     * standard one) — the marker decides, not the reload. */
    eval_god_mode();
    return 0;
}

static void grant_csv(char *out, size_t cap)
{
    size_t n = 0;
    out[0] = '\0';
    for (size_t i = 0; i < g_ngrant; i++) {
        int w = snprintf(out + n, cap - n, "%s%s", i ? "," : "",
                         g_grant[i]);
        if (w < 0 || (size_t)w >= cap - n)
            break;
        n += (size_t)w;
    }
}

/* ------------------------------------------------------------------ */
/* backends                                                            */
/* ------------------------------------------------------------------ */

static char g_backends[MAX_BACKENDS][128];
static size_t g_nbackends = 0;

static int cmp_str(const void *a, const void *b)
{
    return strcmp((const char *)a, (const char *)b);
}

/* Scan the backends directory: every executable regular file is a
 * backend; its id is its filename. Sorted, so LIST order is stable. */
static void scan_backends(void)
{
    g_nbackends = 0;
    DIR *d = opendir(g_backends_dir);
    if (!d) {
        log_line("AID backends dir %s unreadable: %s", g_backends_dir,
                 strerror(errno));
        return;
    }
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.')
            continue;
        if (g_nbackends >= MAX_BACKENDS)
            break;
        char full[4096];
        snprintf(full, sizeof(full), "%s/%s", g_backends_dir,
                 de->d_name);
        struct stat st;
        if (stat(full, &st) != 0 || !S_ISREG(st.st_mode))
            continue;
        if (access(full, X_OK) != 0)
            continue;
        snprintf(g_backends[g_nbackends], sizeof(g_backends[0]), "%s",
                 de->d_name);
        g_nbackends++;
    }
    closedir(d);
    qsort(g_backends, g_nbackends, sizeof(g_backends[0]), cmp_str);
}

static int backend_index(const char *id)
{
    for (size_t i = 0; i < g_nbackends; i++)
        if (strcmp(g_backends[i], id) == 0)
            return (int)i;
    return -1;
}

static void backends_csv(char *out, size_t cap)
{
    size_t n = 0;
    out[0] = '\0';
    for (size_t i = 0; i < g_nbackends; i++) {
        int w = snprintf(out + n, cap - n, "%s%s", i ? "," : "",
                         g_backends[i]);
        if (w < 0 || (size_t)w >= cap - n)
            break;
        n += (size_t)w;
    }
}

/* Per-backend limits (P0): a backend may ship a `<id>.limits` file
 * next to itself with `timeout=<seconds>` and `max_actions=<n>`,
 * one per line. Missing file, bad lines, and out-of-range values
 * all fall back to the defaults — a bad limits file cannot remove
 * the timeout or the action cap. */
static void read_backend_limits(const char *id, int *timeout_s,
                                size_t *max_actions)
{
    *timeout_s = BACKEND_TIMEOUT_S;
    *max_actions = MAX_ACTIONS;
    char path[4096];
    snprintf(path, sizeof(path), "%s/%s.limits", g_backends_dir, id);
    char *text = read_file_cap(path, 4096);
    if (!text)
        return;
    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        while (*line == ' ' || *line == '\t')
            line++;
        if (strncmp(line, "timeout=", 8) == 0) {
            long v = strtol(line + 8, NULL, 10);
            if (v >= 1 && v <= LIMITS_TIMEOUT_MAX_S)
                *timeout_s = (int)v;
        } else if (strncmp(line, "max_actions=", 12) == 0) {
            long v = strtol(line + 12, NULL, 10);
            if (v >= 1 && v <= (long)LIMITS_ACTIONS_MAX)
                *max_actions = (size_t)v;
        }
    }
    free(text);
}

/* ------------------------------------------------------------------ */
/* selection (persisted)                                               */
/* ------------------------------------------------------------------ */

static char g_selected[128] = "echo-ai";

static void load_selection(void)
{
    /* Primary first, then the tmpfs fallback (a daemon restart in a
     * boot without a data disk still finds the choice). */
    char *text = read_file_cap(g_selected_path, 256);
    if (!text && strcmp(g_selected_path, FALLBACK_SELECTED) != 0)
        text = read_file_cap(FALLBACK_SELECTED, 256);
    if (!text) {
        /* No persisted selection yet: default stands. */
        return;
    }
    /* Trim trailing whitespace/newlines. */
    size_t n = strlen(text);
    while (n > 0 && (text[n - 1] == '\n' || text[n - 1] == '\r' ||
                     text[n - 1] == ' ' || text[n - 1] == '\t'))
        text[--n] = '\0';
    if (n > 0 && n < sizeof(g_selected))
        snprintf(g_selected, sizeof(g_selected), "%s", text);
    free(text);
}

static int save_selection(void)
{
    char data[256];
    snprintf(data, sizeof(data), "%s\n", g_selected);
    if (write_file_atomic(g_selected_path, data) == 0)
        return 0;
    /* The data disk may be absent (no /data mount): fall back to the
     * tmpfs path so the choice still holds for this boot. */
    if (strcmp(g_selected_path, FALLBACK_SELECTED) != 0) {
        g_selected_path = FALLBACK_SELECTED;
        return write_file_atomic(g_selected_path, data);
    }
    return -1;
}

/* ------------------------------------------------------------------ */
/* downstream clients: appd + statusd                                  */
/* ------------------------------------------------------------------ */

/* Connect to a Unix socket. -1 on failure. */
static int sock_connect(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) {
        close(fd);
        return -1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/* Send one line (with trailing newline). */
static int sock_send_line(int fd, const char *line)
{
    char buf[LINE_CAP + 2];
    size_t n = strlen(line);
    if (n + 1 >= sizeof(buf))
        return -1;
    memcpy(buf, line, n);
    buf[n++] = '\n';
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, buf + off, n - off);
        if (w <= 0)
            return -1;
        off += (size_t)w;
    }
    return 0;
}

/* Read one line (up to the newline), with a 5 s deadline. Returns
 * the length, 0 on EOF, -1 on error/timeout. */
static int sock_read_line(int fd, char *buf, size_t cap)
{
    size_t n = 0;
    while (n + 1 < cap) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, 5000);
        if (pr <= 0)
            return -1;
        char c;
        ssize_t r = read(fd, &c, 1);
        if (r == 0)
            return n == 0 ? 0 : (int)n;
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        if (c == '\n')
            break;
        buf[n++] = c;
    }
    buf[n] = '\0';
    return (int)n;
}

/* One appd verb: connect, send, read one reply line. Returns 0 when
 * the reply starts with "OK ", -1 otherwise (reason in err). */
static int appd_call(const char *verb_line, char *err, size_t errcap)
{
    int fd = sock_connect(g_appd_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach appd");
        return -1;
    }
    int rc = -1;
    if (sock_send_line(fd, verb_line) == 0) {
        char line[LINE_CAP];
        int n = sock_read_line(fd, line, sizeof(line));
        if (n > 0 && strncmp(line, "OK ", 3) == 0) {
            rc = 0;
        } else if (n > 0) {
            snprintf(err, errcap, "%s", line);
        } else {
            snprintf(err, errcap, "no reply from appd");
        }
    } else {
        snprintf(err, errcap, "cannot talk to appd");
    }
    close(fd);
    return rc;
}

/* appd LIST: count the APP lines (replies are APP <line> ... then
 * "OK list"). Returns the count, or -1 on failure. */
static int appd_list_count(char *err, size_t errcap)
{
    int fd = sock_connect(g_appd_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach appd");
        return -1;
    }
    int count = -1;
    if (sock_send_line(fd, "LIST") == 0) {
        count = 0;
        for (;;) {
            char line[LINE_CAP];
            int n = sock_read_line(fd, line, sizeof(line));
            if (n <= 0) {
                count = -1;
                snprintf(err, errcap, "no reply from appd");
                break;
            }
            if (strncmp(line, "OK ", 3) == 0)
                break;
            if (strncmp(line, "APP ", 4) == 0)
                count++;
        }
    } else {
        snprintf(err, errcap, "cannot talk to appd");
    }
    close(fd);
    return count;
}

/* statusd SET: fire-and-forget — statusd sends no reply, it
 * broadcasts the new value (and logs STATUSD SET, which is what the
 * harness asserts on). */
static int status_set(const char *key, const char *val, char *err,
                      size_t errcap)
{
    int fd = sock_connect(g_status_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach statusd");
        return -1;
    }
    char line[LINE_CAP];
    snprintf(line, sizeof(line), "SET %s %s", key, val);
    int rc = sock_send_line(fd, line);
    if (rc != 0)
        snprintf(err, errcap, "cannot talk to statusd");
    close(fd);
    return rc;
}

/* ------------------------------------------------------------------ */
/* god mode (P2, design §2.4)                                          */
/* ------------------------------------------------------------------ */

/* Read the god-mode marker: {"god_mode": true,
 * "enabled_at": "<iso>", "enabled_by": "cli"|"settings"}. Returns 1
 * when the marker says god mode is on (and copies enabled_by out),
 * 0 otherwise — a missing marker, an unparseable one, or god_mode
 * false all mean OFF. A corrupt marker is never an enable: it logs
 * and falls back to standard, the same fail-closed rule as a bad
 * god grant. */
static int read_god_marker(char *enabled_by, size_t cap)
{
    if (enabled_by && cap > 0)
        enabled_by[0] = '\0';
    char *text = read_file_cap(g_god_marker_path, 4096);
    if (!text)
        return 0;
    char jerr[256];
    jval_t *root = json_parse(text, jerr, sizeof(jerr));
    if (!root) {
        log_line("AID god marker invalid, standard grant in force: %s",
                 jerr);
        free(text);
        return 0;
    }
    int on = json_bool(json_obj_get(root, "god_mode"), 0);
    const char *by = json_str(json_obj_get(root, "enabled_by"));
    if (on && by && enabled_by)
        snprintf(enabled_by, cap, "%s", by);
    json_free(root);
    free(text);
    return on;
}

/* Decide the live grant from the marker. Called at startup (after
 * load_grant) and on every RELOAD/SIGHUP. The standard grant is
 * always the fallback: it was just (re-)read from disk by the
 * caller, so this function only ever swaps the god grant IN, never
 * invents a grant. Returns 1 when god mode is in force, 0 when the
 * standard grant governs. Transitions (off->on, on->off) log the
 * boot line, append the audit event, and SET the statusd key, so
 * god mode is never silent or invisible. */
static int eval_god_mode(void)
{
    char enabled_by[32];
    int marker_on = read_god_marker(enabled_by, sizeof(enabled_by));
    if (!marker_on) {
        if (g_god_mode) {
            g_god_mode = 0;
            log_line("AID god mode off");
            if (audit_append("daemon", "GOD_MODE OFF", "OK",
                             "marker removed", 0) != 0)
                log_line("AID AUDIT FAIL god-mode off event not logged");
            char serr[128];
            if (status_set(GOD_MODE_STATUS_KEY, "off", serr,
                           sizeof(serr)) != 0)
                log_line("AID god mode status key not set: %s", serr);
        }
        return 0;
    }
    char err[256];
    char **god = NULL;
    size_t ngod = 0;
    if (parse_grant_file(g_god_grant_path, &god, &ngod, err,
                         sizeof(err)) != 0) {
        /* A broken god grant degrades to standard, never to "no
         * grant" and never to "everything allowed" (§2.4). */
        log_line("AID god grant invalid, standard grant in force: %s",
                 err);
        if (g_god_mode) {
            g_god_mode = 0;
            if (audit_append("daemon", "GOD_MODE OFF", "OK",
                             "god grant invalid", 0) != 0)
                log_line("AID AUDIT FAIL god-mode off event not logged");
            char serr[128];
            if (status_set(GOD_MODE_STATUS_KEY, "off", serr,
                           sizeof(serr)) != 0)
                log_line("AID god mode status key not set: %s", serr);
        }
        return 0;
    }
    int was_on = g_god_mode;
    free_grant(g_grant, g_ngrant);
    g_grant = god;
    g_ngrant = ngod;
    g_god_mode = 1;
    if (!was_on) {
        /* The D2 boot line (and the reload line): god mode is never
         * silent. */
        log_line("AID god mode active");
        char detail[64];
        snprintf(detail, sizeof(detail), "via=%s",
                 enabled_by[0] ? enabled_by : "unknown");
        if (audit_append("daemon", "GOD_MODE ON", "OK", detail, 0) != 0)
            log_line("AID AUDIT FAIL god-mode on event not logged");
        char serr[128];
        if (status_set(GOD_MODE_STATUS_KEY, "on", serr,
                       sizeof(serr)) != 0)
            log_line("AID god mode status key not set: %s", serr);
    } else {
        log_line("AID god grant loaded (%zu permissions)", ngod);
    }
    return 1;
}

/* Drive the ai.relay state (Phase 2, design §5.2): update the
 * daemon's own view (what STATUS reports) and SET the statusd key
 * the tray reads. The daemon SETs "on" at a relay SESSION start and
 * "idle" at its end (and at boot when the marker exists); it never
 * SETs "off" — the CLI owns that transition, and statusd's default
 * is off. A failed SET is logged, never fatal: the daemon's own
 * view is still correct. */
static void relay_set_state(const char *state)
{
    g_relay = state;
    char serr[128];
    if (status_set(RELAY_STATUS_KEY, state, serr, sizeof(serr)) != 0)
        log_line("AID relay status key not set: %s", serr);
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

/* One backend-proposed action. verb is the raw verb; perm is the
 * permission it needs (NULL = unknown verb, always refused). rest is
 * everything after the verb on the line (EXEC's full CLI args — a
 * CLI verb has more than two tokens, and arg1/arg2 cannot hold it). */
struct action {
    char verb[32];
    char arg1[128];
    char arg2[128];
    char rest[LINE_CAP];
    const char *perm;
};

static const char *perm_for_verb(const char *verb)
{
    if (strcmp(verb, "LAUNCH") == 0)
        return "app.launch";
    if (strcmp(verb, "CLOSE") == 0)
        return "app.close";
    if (strcmp(verb, "LIST") == 0)
        return "app.list";
    if (strcmp(verb, "SET") == 0)
        return "status.set";
    if (strcmp(verb, "UNINSTALL") == 0)
        return "app.uninstall";
    if (strcmp(verb, "INSTALL") == 0)
        return "app.install";
    if (strcmp(verb, "REBOOT") == 0)
        return "system.reboot";
    /* P0: READ is a read-only action (its executor only ever reads,
     * and the ASK loop lets it through without a grant — §1.4.1,
     * "reads need no grant"). EXEC runs `sevyn` CLI verbs only
     * (D5, no raw shell); it is grant-checked like the rest, so
     * under the standard grant (which has no cli.exec) it is
     * refused, and it only runs when a grant names it. */
    if (strcmp(verb, "READ") == 0)
        return "state.read";
    if (strcmp(verb, "EXEC") == 0)
        return "cli.exec";
    /* P1: WRITE replaces a file (bounded, §1.4.3) and UPDATE
     * checks/applies a system update. Both are grant-checked; the
     * standard grant names neither, so under it both are refused —
     * they only run when a grant names them (god mode, P2, names
     * both). No grant is invented here. */
    if (strcmp(verb, "WRITE") == 0)
        return "file.write";
    if (strcmp(verb, "UPDATE") == 0)
        return "system.update";
    return NULL;
}

/* Parse one backend action line into an action. Returns 0 on success,
 * -1 on a line that is not an action at all (blank / garbage). */
static int parse_action(const char *line, struct action *a)
{
    memset(a, 0, sizeof(*a));
    char verb[32], arg1[128], arg2[128];
    int n = sscanf(line, "%31s %127s %127s", verb, arg1, arg2);
    if (n < 1)
        return -1;
    snprintf(a->verb, sizeof(a->verb), "%s", verb);
    if (n >= 2)
        snprintf(a->arg1, sizeof(a->arg1), "%s", arg1);
    if (n >= 3)
        snprintf(a->arg2, sizeof(a->arg2), "%s", arg2);
    /* The remainder after the verb (EXEC's full CLI args). Skip the
     * verb token, then the whitespace that follows it. */
    const char *p = line;
    while (*p && *p != ' ' && *p != '\t')
        p++;
    while (*p == ' ' || *p == '\t')
        p++;
    snprintf(a->rest, sizeof(a->rest), "%s", p);
    a->perm = perm_for_verb(verb);
    /* A line that is not a known verb is backend chatter, not an
     * action: ignore it (a backend may print debug output). Only
     * action-shaped lines act — and only known verbs outside the
     * grant are DENIED, never executed. */
    if (!a->perm)
        return -1;
    /* Arity: LAUNCH/CLOSE/UNINSTALL/INSTALL/READ take one arg; SET
     * takes two; LIST/REBOOT take none; EXEC takes the rest of the
     * line (at least one token). A malformed action is not an
     * action. */
    if ((strcmp(verb, "LAUNCH") == 0 || strcmp(verb, "CLOSE") == 0 ||
         strcmp(verb, "UNINSTALL") == 0 ||
         strcmp(verb, "INSTALL") == 0 ||
         strcmp(verb, "READ") == 0) &&
        n != 2)
        return -1;
    if (strcmp(verb, "SET") == 0 && n != 3)
        return -1;
    if ((strcmp(verb, "LIST") == 0 || strcmp(verb, "REBOOT") == 0) &&
        n != 1)
        return -1;
    if (strcmp(verb, "EXEC") == 0 && a->rest[0] == '\0')
        return -1;
    /* P1: WRITE takes a path plus content (the rest of the line
     * after the path, with \n escapes). The path token must fit
     * arg1 whole (127 chars) and the content must be non-empty —
     * a WRITE with no content is not an action. */
    if (strcmp(verb, "WRITE") == 0) {
        if (n < 2)
            return -1;
        const char *p = a->rest;
        size_t plen = 0;
        while (p[plen] && p[plen] != ' ' && p[plen] != '\t')
            plen++;
        if (plen == 0 || plen >= sizeof(a->arg1))
            return -1;
        p += plen;
        while (*p == ' ' || *p == '\t')
            p++;
        if (*p == '\0')
            return -1;
    }
    /* P1: UPDATE takes no argument (check) or exactly "apply". */
    if (strcmp(verb, "UPDATE") == 0 &&
        !(n == 1 || (n == 2 && strcmp(arg1, "apply") == 0)))
        return -1;
    return 0;
}

/* READ executor (P0): a read-only action. The backend reads the
 * file itself for its own planning (phase 1 has no return channel
 * from the daemon to the backend); this executor validates the read
 * is inside the bounds and puts it in the audit trail, so every
 * fetch the AI makes is logged. The content is NOT returned to the
 * backend here — the backend already has it.
 *
 * Bounds: absolute path only, under /data/ or /var/lib/sevyn/ (the
 * settings, logs, and app registry), never under the pristine stock
 * bundles, no ".." traversal, regular file only, capped at
 * READ_CAP. Anything outside is refused, never read. */
static int read_path_allowed(const char *path)
{
    if (!path || path[0] != '/')
        return 0;
    if (strstr(path, "..") != NULL)
        return 0;
    if (g_read_root) {
        size_t n = strlen(g_read_root);
        return strncmp(path, g_read_root, n) == 0 && path[n] == '/';
    }
    if (strncmp(path, "/data/", 6) != 0 &&
        strncmp(path, "/var/lib/sevyn/", 15) != 0)
        return 0;
    return 1;
}

static int exec_read(const struct action *a, char *err, size_t errcap)
{
    if (!read_path_allowed(a->arg1)) {
        snprintf(err, errcap, "READ path not allowed: %s", a->arg1);
        return -1;
    }
    struct stat st;
    if (stat(a->arg1, &st) != 0) {
        snprintf(err, errcap, "READ cannot stat %s: %s", a->arg1,
                 strerror(errno));
        return -1;
    }
    if (!S_ISREG(st.st_mode)) {
        snprintf(err, errcap, "READ not a regular file: %s", a->arg1);
        return -1;
    }
    /* Over the per-read cap: refuse, don't truncate (the backend
     * refuses the same way — a truncated prefix would mislead the
     * model into thinking it read the whole file). */
    if (st.st_size > (off_t)READ_CAP) {
        snprintf(err, errcap, "READ file over the 64 KiB cap: %s",
                 a->arg1);
        return -1;
    }
    /* Read (and discard) up to READ_CAP, so the read is real and
     * bounded — a backend cannot claim a read of an unbounded file. */
    FILE *f = fopen(a->arg1, "r");
    if (!f) {
        snprintf(err, errcap, "READ cannot open %s: %s", a->arg1,
                 strerror(errno));
        return -1;
    }
    char *buf = malloc(READ_CAP);
    if (!buf) {
        fclose(f);
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    size_t n = fread(buf, 1, READ_CAP, f);
    free(buf);
    fclose(f);
    snprintf(err, errcap, "%zu bytes", n);
    return 0;
}

/* WRITE executor (P1, §1.4.3): replaces a file's content. Bounds:
 * absolute path only, under /data/ or /var/lib/sevyn/ (or the
 * test-only SEVYN_AI_WRITE_ROOT), never under the pristine stock
 * bundles, no ".." traversal. The previous copy is kept as
 * <path>.sevyn-bak so a bad AI write is one rename from undo, and
 * the file's mode is preserved (a 0600 file must not come back
 * 0644). A file the backend could not have fully read is not
 * replaced: the existing file must fit the READ cap. Content rides
 * the action line with \n escapes (one line); the wire content is
 * therefore bounded by LINE_CAP. Every write is logged with the
 * full path. */
static int write_path_allowed(const char *path)
{
    if (!path || path[0] != '/')
        return 0;
    if (strstr(path, "..") != NULL)
        return 0;
    /* Pristine first: it holds even if the roots below are ever
     * widened (design §3.5). */
    if (strncmp(path, PRISTINE_PREFIX,
                sizeof(PRISTINE_PREFIX) - 1) == 0)
        return 0;
    if (g_write_root) {
        size_t n = strlen(g_write_root);
        return strncmp(path, g_write_root, n) == 0 && path[n] == '/';
    }
    if (strncmp(path, "/data/", 6) != 0 &&
        strncmp(path, "/var/lib/sevyn/", 15) != 0)
        return 0;
    return 1;
}

/* Decode the wire content: \n -> newline, \t -> tab, \\ ->
 * backslash; any other \x stays literal (backslash + char).
 * Returns malloc'd text. */
static char *unescape_write_content(const char *wire)
{
    size_t n = strlen(wire);
    char *out = malloc(n + 1);
    if (!out)
        return NULL;
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        if (wire[i] == '\\' && i + 1 < n) {
            char c = wire[i + 1];
            if (c == 'n') {
                out[w++] = '\n';
                i++;
            } else if (c == 't') {
                out[w++] = '\t';
                i++;
            } else if (c == '\\') {
                out[w++] = '\\';
                i++;
            } else {
                out[w++] = wire[i];
            }
        } else {
            out[w++] = wire[i];
        }
    }
    out[w] = '\0';
    return out;
}

/* Copy a file byte-exact (the .sevyn-bak must be a true copy, even
 * for a binary file — write_file_atomic is a C-string writer and
 * would stop at the first NUL). tmp + rename, like the atomic
 * writer. Returns 0 on success, -1 on failure. */
static int copy_file_exact(const char *src, const char *dst)
{
    /* The tmp name is built by hand, not snprintf: dst is an
     * unbounded pointer to the compiler, and a "%s.tmp" snprintf
     * would warn (and could truncate a long path). The length
     * check makes the copy provably safe. */
    char tmp[4096];
    size_t dlen = strlen(dst);
    if (dlen + 5 > sizeof(tmp))
        return -1;
    memcpy(tmp, dst, dlen);
    memcpy(tmp + dlen, ".tmp", 5);
    FILE *in = fopen(src, "rb");
    if (!in)
        return -1;
    FILE *out = fopen(tmp, "wb");
    if (!out) {
        fclose(in);
        return -1;
    }
    char buf[8192];
    size_t n;
    int rc = 0;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) {
            rc = -1;
            break;
        }
    }
    if (ferror(in))
        rc = -1;
    if (fclose(out) != 0)
        rc = -1;
    fclose(in);
    if (rc != 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, dst) != 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

static int exec_write(const struct action *a, char *err, size_t errcap)
{
    const char *path = a->arg1;
    if (!write_path_allowed(path)) {
        snprintf(err, errcap, "WRITE path not allowed: %s", path);
        return -1;
    }
    /* Content is the rest of the line after the path token. */
    const char *p = a->rest;
    while (*p && *p != ' ' && *p != '\t')
        p++;
    while (*p == ' ' || *p == '\t')
        p++;
    char *content = unescape_write_content(p);
    if (!content) {
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    struct stat st;
    int exists = (stat(path, &st) == 0);
    mode_t old_mode = 0;
    if (exists) {
        if (!S_ISREG(st.st_mode)) {
            free(content);
            snprintf(err, errcap, "WRITE not a regular file: %s",
                     path);
            return -1;
        }
        /* Refuse to replace a file the backend could not have
         * fully read — replacing it would destroy content the
         * model never saw. */
        if (st.st_size > (off_t)WRITE_EXISTING_CAP) {
            free(content);
            snprintf(err, errcap,
                     "WRITE file over the 64 KiB cap: %s", path);
            return -1;
        }
        old_mode = st.st_mode & 07777;
        /* Keep the previous copy next to the file, so a bad write
         * is one rename from undo (§1.4.3 — a requirement, not a
         * nice-to-have). The path is an action token (127 chars),
         * so the .sevyn-bak name fits in 160 with room. */
        char bak[160];
        snprintf(bak, sizeof(bak), "%s.sevyn-bak", path);
        if (copy_file_exact(path, bak) != 0) {
            free(content);
            snprintf(err, errcap, "WRITE cannot back up %s: %s",
                     path, strerror(errno));
            return -1;
        }
    } else {
        /* A new file: the parent directory must already exist.
         * The path is an action token (127 chars), so the parent
         * fits in 128. */
        char parent[128];
        snprintf(parent, sizeof(parent), "%s", path);
        char *slash = strrchr(parent, '/');
        if (!slash || slash == parent) {
            free(content);
            snprintf(err, errcap, "WRITE bad parent for %s", path);
            return -1;
        }
        *slash = '\0';
        struct stat pst;
        if (stat(parent, &pst) != 0 || !S_ISDIR(pst.st_mode)) {
            free(content);
            snprintf(err, errcap,
                     "WRITE parent directory missing: %s", parent);
            return -1;
        }
    }
    if (write_file_atomic(path, content) != 0) {
        free(content);
        snprintf(err, errcap, "WRITE cannot write %s: %s", path,
                 strerror(errno));
        return -1;
    }
    /* Preserve the mode a sensitive file had (0600 stays 0600). */
    if (exists)
        (void)!chmod(path, old_mode);
    size_t nbytes = strlen(content);
    free(content);
    if (exists)
        log_line("AID WRITE %s (%zu bytes, backup %s.sevyn-bak)",
                 path, nbytes, path);
    else
        log_line("AID WRITE %s (%zu bytes, new file)", path, nbytes);
    snprintf(err, errcap, "%zu bytes written", nbytes);
    return 0;
}

/* EXEC executor (P0): runs `sevyn` CLI verbs only, never a bare
 * shell (D5). The args are split on whitespace (no quote handling
 * — the backend emits simple verb tokens) and exec'd directly.
 * The child's output is discarded; only its exit code matters. A
 * 30 s deadline bounds a hung CLI verb so one EXEC cannot stall the
 * daemon. */
/* Run a `sevyn` CLI argv: fork, execv, wait up to timeout_s. When
 * out is non-NULL, the child's stdout is captured into it (up to
 * out_cap-1 bytes, NUL-terminated, first line kept whole); otherwise
 * stdout goes to /dev/null. Returns 0 on exit 0, -1 with reason in
 * err. A timeout kills the child and is a failure — except the
 * UPDATE apply path, which does not use this helper (it requests
 * the apply and detaches). Shared by EXEC and UPDATE check. */
static int run_cli_argv(char *const argv[], int timeout_s, char *out,
                        size_t out_cap, char *err, size_t errcap)
{
    int out_pipe[2] = { -1, -1 };
    if (out && pipe(out_pipe) != 0) {
        snprintf(err, errcap, "cannot create pipe: %s",
                 strerror(errno));
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        if (out) {
            close(out_pipe[0]);
            close(out_pipe[1]);
        }
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        if (out) {
            /* UPDATE check: stdout is captured; stderr stays on
             * the daemon's stderr so a failing check is visible
             * in the log. */
            close(out_pipe[0]);
            dup2(out_pipe[1], STDOUT_FILENO);
            close(out_pipe[1]);
        } else {
            /* EXEC: stdout and stderr are both discarded. */
            int nullfd = open("/dev/null", O_RDWR);
            if (nullfd >= 0) {
                dup2(nullfd, STDOUT_FILENO);
                dup2(nullfd, STDERR_FILENO);
            }
        }
        execv(g_cli_path, argv);
        _exit(127);
    }
    if (out)
        close(out_pipe[1]);
    /* Bounded wait: a CLI verb that does not finish in timeout_s
     * is killed, so one action cannot stall the daemon. */
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += timeout_s;
    int status = 0;
    size_t olen = 0;
    if (out)
        out[0] = '\0';
    for (;;) {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid)
            break;
        if (w < 0 && errno != EINTR) {
            snprintf(err, errcap, "waitpid failed: %s",
                     strerror(errno));
            if (out)
                close(out_pipe[0]);
            return -1;
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec &&
             now.tv_nsec >= deadline.tv_nsec)) {
            kill(pid, SIGKILL);
            while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
            }
            if (out)
                close(out_pipe[0]);
            snprintf(err, errcap, "CLI verb timed out");
            return -1;
        }
        /* Drain captured stdout while waiting, so a chatty child
         * cannot block on a full pipe. */
        if (out) {
            struct pollfd pfd = { .fd = out_pipe[0], .events = POLLIN };
            if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
                char tmp[1024];
                ssize_t r = read(out_pipe[0], tmp, sizeof(tmp));
                if (r > 0 && olen + 1 < out_cap) {
                    size_t take = (size_t)r;
                    if (olen + take >= out_cap)
                        take = out_cap - olen - 1;
                    memcpy(out + olen, tmp, take);
                    olen += take;
                    out[olen] = '\0';
                }
            }
        }
        struct timespec nap = { .tv_sec = 0, .tv_nsec = 50 * 1000000 };
        nanosleep(&nap, NULL);
    }
    /* Drain whatever is left after exit (the child is done, so
     * this cannot block: the pipe is empty or at EOF). */
    if (out) {
        for (;;) {
            char tmp[1024];
            ssize_t r = read(out_pipe[0], tmp, sizeof(tmp));
            if (r <= 0)
                break;
            if (olen + 1 < out_cap) {
                size_t take = (size_t)r;
                if (olen + take >= out_cap)
                    take = out_cap - olen - 1;
                memcpy(out + olen, tmp, take);
                olen += take;
                out[olen] = '\0';
            }
        }
        close(out_pipe[0]);
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0)
        return 0;
    if (WIFEXITED(status)) {
        snprintf(err, errcap, "sevyn exited %d", WEXITSTATUS(status));
        return -1;
    }
    snprintf(err, errcap, "sevyn did not exit cleanly");
    return -1;
}

static int exec_cli(const struct action *a, char *err, size_t errcap)
{
    char *argv[34];
    char args[LINE_CAP];
    snprintf(args, sizeof(args), "%s", a->rest);
    int nargs = 0;
    argv[nargs++] = (char *)g_cli_path;
    char *save = NULL;
    for (char *tok = strtok_r(args, " \t", &save); tok && nargs < 33;
         tok = strtok_r(NULL, " \t", &save))
        argv[nargs++] = tok;
    argv[nargs] = NULL;
    if (nargs < 2) {
        snprintf(err, errcap, "EXEC needs a CLI verb");
        return -1;
    }
    return run_cli_argv(argv, 30, NULL, 0, err, errcap);
}

/* UPDATE executor (P1): check/apply via the existing updater
 * (`sevyn update check` / `apply`), never a new ad-hoc path. The
 * apply still verifies signatures against the existing trust
 * anchors (the updater's job, not this executor's).
 *
 * UPDATE (check) runs the check and reports the result — the
 * captured output is the detail, so a session backend learns
 * whether an update is available.
 *
 * UPDATE apply requests the apply and detaches: the CLI child
 * downloads and the device reboots when it lands, so the daemon
 * only waits long enough to catch an immediate failure (a missing
 * update, a bad CLI path). A child still running after that window
 * is a requested apply, not a failure — killing it would be worse
 * than letting the updater finish, and the reboot reaps it. */
static int exec_update(const struct action *a, char *err, size_t errcap)
{
    if (a->arg1[0] == '\0') {
        char *argv[] = { (char *)g_cli_path, "update", "check", NULL };
        char out[512];
        if (run_cli_argv(argv, UPDATE_CHECK_TIMEOUT_S, out,
                         sizeof(out), err, errcap) != 0)
            return -1;
        /* The check's output is the result the backend acts on:
         * keep the first line, trimmed, as the detail. */
        char *nl = strchr(out, '\n');
        if (nl)
            *nl = '\0';
        size_t n = strlen(out);
        while (n > 0 && (out[n - 1] == ' ' || out[n - 1] == '\r' ||
                         out[n - 1] == '\t'))
            out[--n] = '\0';
        if (out[0] == '\0')
            snprintf(err, errcap, "update check ok");
        else
            snprintf(err, errcap, "%s", out);
        log_line("AID UPDATE check: %s", err);
        return 0;
    }
    /* apply */
    char *argv[] = { (char *)g_cli_path, "update", "apply", NULL };
    pid_t pid = fork();
    if (pid < 0) {
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0) {
            dup2(nullfd, STDOUT_FILENO);
            dup2(nullfd, STDERR_FILENO);
        }
        execv(g_cli_path, argv);
        _exit(127);
    }
    /* Brief window: catch an immediate failure (bad CLI path, no
     * update available — the CLI exits fast). A child still running
     * after it is genuinely applying; detach and report requested. */
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += UPDATE_APPLY_WAIT_S;
    for (;;) {
        int status = 0;
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) {
            if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
                snprintf(err, errcap, "update applied");
                log_line("AID UPDATE apply: finished (exit 0)");
                return 0;
            }
            if (WIFEXITED(status)) {
                snprintf(err, errcap, "sevyn exited %d",
                         WEXITSTATUS(status));
                return -1;
            }
            snprintf(err, errcap, "sevyn did not exit cleanly");
            return -1;
        }
        if (w < 0 && errno != EINTR) {
            snprintf(err, errcap, "waitpid failed: %s",
                     strerror(errno));
            return -1;
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec &&
             now.tv_nsec >= deadline.tv_nsec)) {
            /* Still running: the apply is proceeding. Detach —
             * the device reboots when it lands, which reaps the
             * child; the daemon must not kill it mid-download. */
            log_line("AID UPDATE apply requested");
            snprintf(err, errcap, "update apply requested");
            return 0;
        }
        struct timespec nap = { .tv_sec = 0, .tv_nsec = 50 * 1000000 };
        nanosleep(&nap, NULL);
    }
}

/* INSTALL executor (P2, §2.2): the existing .sevyn bundle install
 * path — appd runs the loader's install on the bundle path. A
 * bundle that would replace or become a system app still needs its
 * signature (the loader's job, not this executor's); god mode does
 * not waive it. The path is an action token (127 chars). */
static int exec_install(const struct action *a, char *err, size_t errcap)
{
    char verb_line[LINE_CAP];
    snprintf(verb_line, sizeof(verb_line), "INSTALL %s", a->arg1);
    int rc = appd_call(verb_line, err, errcap);
    if (rc == 0)
        log_line("AID INSTALL %s", a->arg1);
    return rc;
}

/* Protected apps (design §3.3): shell + terminal can never be
 * uninstalled, in god mode or any other mode — the Terminal is the
 * recovery path. The guard lives HERE, in the executor, not in the
 * grant, so no grant file can waive it. (The loader refuses them
 * too, from the registry's protected flag; this is the daemon's own
 * guard, and the one the harness asserts on.) */
static int app_is_protected(const char *id)
{
    return strcmp(id, "shell") == 0 || strcmp(id, "terminal") == 0;
}

/* UNINSTALL executor (P2, §2.2): the existing registry removal
 * path through appd. Returns -2 (policy refusal) for a protected
 * app — run_one_action counts that as a denial with a distinct
 * "protected app" log line, not an executor failure. */
static int exec_uninstall(const struct action *a, char *err,
                          size_t errcap)
{
    if (app_is_protected(a->arg1)) {
        snprintf(err, errcap, "protected app");
        return -2;
    }
    char verb_line[LINE_CAP];
    snprintf(verb_line, sizeof(verb_line), "UNINSTALL %s", a->arg1);
    int rc = appd_call(verb_line, err, errcap);
    if (rc == 0)
        log_line("AID UNINSTALL %s", a->arg1);
    return rc;
}

/* REBOOT executor (P2, §2.2): the existing safe reboot path —
 * `sevyn reboot` asks statusd, which signals init for the clean
 * teardown. The CLI prints "reboot requested" and exits 0 once the
 * request is sent; the device goes down a second later, so the
 * daemon's reply (OK, allowed=1) lands before the reboot. Never a
 * raw reboot() call from the daemon, never a new mechanism. */
static int exec_reboot(const struct action *a, char *err, size_t errcap)
{
    (void)a;
    char *argv[] = { (char *)g_cli_path, "reboot", NULL };
    if (run_cli_argv(argv, REBOOT_TIMEOUT_S, NULL, 0, err, errcap) != 0)
        return -1;
    log_line("AID REBOOT requested");
    snprintf(err, errcap, "reboot requested");
    return 0;
}

/* Execute one granted action. Returns 0 on success, -1 with reason
 * in err, -2 when the action is refused by a policy guard that lives
 * in the executor (the protected-apps guard below) — run_one_action
 * counts -2 as a denial with a distinct log line, not a failure.
 * INSTALL/UNINSTALL/REBOOT (P2) run only when a grant names them
 * (god mode); under the standard grant they never reach here. */
static int execute_action(const struct action *a, char *err,
                          size_t errcap)
{
    char verb_line[LINE_CAP];
    if (strcmp(a->verb, "LAUNCH") == 0) {
        snprintf(verb_line, sizeof(verb_line), "LAUNCH %s", a->arg1);
        return appd_call(verb_line, err, errcap);
    }
    if (strcmp(a->verb, "CLOSE") == 0) {
        snprintf(verb_line, sizeof(verb_line), "CLOSE %s", a->arg1);
        return appd_call(verb_line, err, errcap);
    }
    if (strcmp(a->verb, "LIST") == 0) {
        int count = appd_list_count(err, errcap);
        if (count < 0)
            return -1;
        snprintf(err, errcap, "%d apps", count);
        return 0;
    }
    if (strcmp(a->verb, "SET") == 0)
        return status_set(a->arg1, a->arg2, err, errcap);
    if (strcmp(a->verb, "READ") == 0)
        return exec_read(a, err, errcap);
    if (strcmp(a->verb, "EXEC") == 0)
        return exec_cli(a, err, errcap);
    /* P1: WRITE replaces a file (bounded, §1.4.3) and UPDATE
     * checks/applies a system update via the existing updater. */
    if (strcmp(a->verb, "WRITE") == 0)
        return exec_write(a, err, errcap);
    if (strcmp(a->verb, "UPDATE") == 0)
        return exec_update(a, err, errcap);
    /* P2: INSTALL / UNINSTALL / REBOOT — the god-mode executors
     * (§2.2). Each is wired to an existing system path, never a new
     * ad-hoc one: INSTALL/UNINSTALL go through appd (which runs
     * the loader's install/uninstall), REBOOT runs `sevyn reboot`
     * (statusd asks init; the device goes down a second later). */
    if (strcmp(a->verb, "INSTALL") == 0)
        return exec_install(a, err, errcap);
    if (strcmp(a->verb, "UNINSTALL") == 0)
        return exec_uninstall(a, err, errcap);
    if (strcmp(a->verb, "REBOOT") == 0)
        return exec_reboot(a, err, errcap);
    snprintf(err, errcap, "no executor for %s", a->verb);
    return -1;
}

/* Run one action: the permission boundary lives here and nowhere
 * else — a grant-check and an executor call, with the log. Returns
 * 1 when the action ran (allowed), 0 when it was refused by the
 * grant (denied), -1 when the executor failed. The detail (the
 * executor's result, or the refusal reason) lands in `detail` so
 * a session backend can see what happened and re-plan. READ is the
 * exception: reads change nothing, so they need no grant (§1.4.1)
 * — the executor still bounds and logs the read. The ASK loop and
 * the SESSION loop both call this, so a grant decision is made in
 * exactly one place. Every outcome is appended to the audit log
 * (§2.5); the log is probed BEFORE anything runs, so a broken log
 * refuses the action instead of letting it run unlogged
 * (fail-closed). An executor policy refusal (-2, the protected-apps
 * guard) counts as a denial with its own log line, not a failure.
 * via_relay (Phase 2) marks relay-driven actions in the audit log
 * — it changes the marking only, never the grant decision. */
static int run_one_action(const struct action *a, char *detail,
                          size_t detail_cap, int via_relay)
{
    char action_line[LINE_CAP];
    if (strcmp(a->verb, "EXEC") == 0)
        /* The rest is bounded by the action line (2048); the
         * precision keeps the log line inside it. */
        snprintf(action_line, sizeof(action_line), "EXEC %.2042s",
                 a->rest);
    else if (a->arg2[0])
        snprintf(action_line, sizeof(action_line), "%s %s %s", a->verb,
                 a->arg1, a->arg2);
    else if (a->arg1[0])
        snprintf(action_line, sizeof(action_line), "%s %s", a->verb,
                 a->arg1);
    else
        snprintf(action_line, sizeof(action_line), "%s", a->verb);
    /* Fail-closed audit (§2.5): the action does not run — and a
     * denial is not even decided — unless the audit log is
     * writable. The probe opens (and creates) the log without
     * writing a line; the appends below record the outcome. */
    if (audit_probe() != 0) {
        log_line("AID AUDIT FAIL %s %s: audit log unavailable",
                 g_selected, action_line);
        snprintf(detail, detail_cap, "audit log unavailable");
        return -1;
    }
    if (strcmp(a->verb, "READ") != 0 &&
        (!a->perm || !grant_has(a->perm))) {
        log_line("AID DENIED %s %s (%s)", g_selected, action_line,
                 a->perm ? a->perm : "unknown action");
        if (audit_append(g_selected, action_line, "DENIED",
                         a->perm ? a->perm : "unknown action",
                         via_relay) != 0)
            log_line("AID AUDIT FAIL %s %s: denial not logged",
                     g_selected, action_line);
        snprintf(detail, detail_cap, "%s",
                 a->perm ? a->perm : "unknown action");
        return 0;
    }
    char xerr[256];
    int xrc = execute_action(a, xerr, sizeof(xerr));
    if (xrc == 0) {
        log_line("AID ALLOW %s %s", g_selected, action_line);
        if (audit_append(g_selected, action_line, "OK", xerr,
                         via_relay) != 0)
            log_line("AID AUDIT FAIL %s %s: action not logged",
                     g_selected, action_line);
        snprintf(detail, detail_cap, "%s", xerr);
        return 1;
    }
    if (xrc == -2) {
        /* Policy refusal from the executor (the protected-apps
         * guard): a denial, not a failure — the design's distinct
         * "AID DENIED … protected app" line (§2.6 check 3). */
        log_line("AID DENIED %s %s (protected app)", g_selected,
                 action_line);
        if (audit_append(g_selected, action_line, "DENIED",
                         "protected app", via_relay) != 0)
            log_line("AID AUDIT FAIL %s %s: denial not logged",
                     g_selected, action_line);
        snprintf(detail, detail_cap, "protected app");
        return 0;
    }
    log_line("AID EXEC FAIL %s %s: %s", g_selected, action_line, xerr);
    if (audit_append(g_selected, action_line, "FAILED", xerr,
                     via_relay) != 0)
        log_line("AID AUDIT FAIL %s %s: failure not logged",
                 g_selected, action_line);
    snprintf(detail, detail_cap, "%s", xerr);
    return -1;
}

/* ------------------------------------------------------------------ */
/* backends: spawn + run                                               */
/* ------------------------------------------------------------------ */

/* Stash the first backend ERR chatter line (muse-ai prints one, then
 * END, when the API call fails: no key, unreachable, HTTP status,
 * malformed). Only the first is kept — it is the root cause — and the
 * text is single-line by construction, so the reply stays one line.
 * A no-op when the stash is already set or the caller passed none. */
static void stash_backend_err(char *backend_err, size_t backend_errcap,
                              const char *line)
{
    if (!backend_err || backend_errcap == 0 || backend_err[0] != '\0')
        return;
    snprintf(backend_err, backend_errcap, "%s", line + 4);
    for (char *p = backend_err; *p; p++) {
        if (*p == '\n' || *p == '\r')
            *p = ' ';
    }
}

/* Run one backend on a task: write the task line to its stdin, read
 * action lines from its stdout until END / EOF / timeout. timeout_s
 * and max_actions are the backend's own limits (P0: read from its
 * .limits file, defaults 5 s / 32); a runaway backend is still
 * killed — the timeout grows, it does not disappear. The task line
 * may be TASK_CAP (16 KiB); backend action lines stay LINE_CAP.
 * Returns 0 with the parsed actions, -1 with reason in err. An
 * ERR chatter line the backend prints is stashed in backend_err
 * (first one only) so the reply can name the failure's cause. */
static int run_backend(const char *backend_path, const char *task,
                       int timeout_s, size_t max_actions,
                       struct action *actions, size_t *n_actions,
                       char *err, size_t errcap,
                       char *backend_err, size_t backend_errcap)
{
    if (backend_err && backend_errcap > 0)
        backend_err[0] = '\0';
    int in_pipe[2], out_pipe[2];
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) {
        snprintf(err, errcap, "cannot create pipes");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(in_pipe[0]);
        close(in_pipe[1]);
        close(out_pipe[0]);
        close(out_pipe[1]);
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        /* Child: async-signal-safe calls only, then exec. */
        close(in_pipe[1]);
        close(out_pipe[0]);
        dup2(in_pipe[0], STDIN_FILENO);
        dup2(out_pipe[1], STDOUT_FILENO);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0)
            dup2(nullfd, STDERR_FILENO);
        execl(backend_path, backend_path, (char *)NULL);
        _exit(127);
    }
    close(in_pipe[0]);
    close(out_pipe[1]);

    /* Feed the task, then close stdin (the backend reads one line). */
    char task_line[TASK_CAP + 2];
    snprintf(task_line, sizeof(task_line), "%s\n", task);
    size_t off = 0, total = strlen(task_line);
    while (off < total) {
        ssize_t w = write(in_pipe[1], task_line + off, total - off);
        if (w <= 0)
            break;
        off += (size_t)w;
    }
    close(in_pipe[1]);

    *n_actions = 0;
    int rc = 0;
    char line[LINE_CAP];
    size_t llen = 0;
    int saw_end = 0;
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += timeout_s;
    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long remain_ms =
            (deadline.tv_sec - now.tv_sec) * 1000 +
            (deadline.tv_nsec - now.tv_nsec) / 1000000;
        if (remain_ms <= 0) {
            kill(pid, SIGKILL);
            snprintf(err, errcap, "backend timed out");
            rc = -1;
            break;
        }
        struct pollfd pfd = { .fd = out_pipe[0], .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain_ms);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            snprintf(err, errcap, "poll failed: %s", strerror(errno));
            rc = -1;
            break;
        }
        if (pr == 0) {
            kill(pid, SIGKILL);
            snprintf(err, errcap, "backend timed out");
            rc = -1;
            break;
        }
        char c;
        ssize_t r = read(out_pipe[0], &c, 1);
        if (r == 0)
            break; /* EOF */
        if (r < 0) {
            if (errno == EINTR)
                continue;
            snprintf(err, errcap, "read failed: %s", strerror(errno));
            rc = -1;
            break;
        }
        if (c == '\n') {
            line[llen] = '\0';
            llen = 0;
            if (strcmp(line, "END") == 0) {
                saw_end = 1;
                break;
            }
            if (line[0] == '\0')
                continue;
            if (*n_actions >= max_actions) {
                snprintf(err, errcap, "backend proposed too many actions");
                rc = -1;
                break;
            }
            struct action a;
            if (parse_action(line, &a) == 0) {
                actions[(*n_actions)++] = a;
            } else if (strncmp(line, "ERR ", 4) == 0) {
                /* A backend ERR line is why it produced no actions —
                 * stash the first one so the reply names the cause
                 * instead of a bare 0/0/0. */
                stash_backend_err(backend_err, backend_errcap, line);
            }
            /* Unparseable lines are ignored, not fatal: a backend
             * may print chatter; only action-shaped lines act. */
        } else if (llen + 1 < sizeof(line)) {
            line[llen++] = c;
        }
    }
    close(out_pipe[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    if (rc == 0 && !saw_end) {
        /* EOF without END: accept the actions read so far (the
         * backend may just exit); log it so a sloppy backend is
         * visible in the log. */
        log_line("AID backend ended without END (%zu actions kept)",
                 *n_actions);
    }
    return rc;
}

/* Read one line from fd with a deadline (timeout_s from now).
 * Returns 1 with the line (NUL-terminated, newline stripped), 0 on
 * EOF, -1 on timeout, -2 on a read error. A line longer than the
 * buffer is truncated, not fatal — the rest is discarded up to the
 * newline, matching run_backend. */
static int read_line_deadline(int fd, char *line, size_t cap,
                              int timeout_s)
{
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += timeout_s;
    size_t llen = 0;
    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long remain_ms = (deadline.tv_sec - now.tv_sec) * 1000 +
                         (deadline.tv_nsec - now.tv_nsec) / 1000000;
        if (remain_ms <= 0)
            return -1;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain_ms);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            return -2;
        }
        if (pr == 0)
            return -1;
        char c;
        ssize_t r = read(fd, &c, 1);
        if (r == 0)
            return 0;
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return -2;
        }
        if (c == '\n') {
            line[llen] = '\0';
            return 1;
        }
        if (llen + 1 < cap)
            line[llen++] = c;
    }
}

/* Write the whole buffer, ignoring a dead pipe (a batch backend
 * that already exited). Returns 0 on success, -1 when the pipe is
 * gone — the caller treats that as "the backend left" and reads
 * on to EOF. */
static int write_all_quiet(int fd, const char *buf, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, buf + off, len - off);
        if (w <= 0)
            return -1;
        off += (size_t)w;
    }
    return 0;
}

/* Session protocol (P1, §1.4.1, phase 2): the daemon and the
 * backend talk action-by-action, so the agent loop can run
 * read -> fix -> re-check in one session instead of one shot.
 *
 * The daemon writes "SESSION\n" then the task line to the
 * backend's stdin (the marker tells the backend it is in session
 * mode; a backend run via ASK sees the task directly, no marker).
 * After each action the daemon writes "RESULT OK <detail>" /
 * "RESULT DENIED <perm>" / "RESULT FAILED <reason>" back to the
 * backend's stdin, so the backend learns what happened and can
 * re-plan. The backend ends the session by printing END.
 *
 * Per-action budget (D8): each action read gets a fresh deadline
 * of the backend's own timeout (muse-ai 300 s, others 5 s) — the
 * single-shot timeout is replaced, not removed. Total actions are
 * capped by max_actions (muse-ai 64, others 32). A batch backend
 * that prints all its actions then END still works: the RESULT
 * writes to a dead pipe fail silently and the actions run in
 * order.
 *
 * Returns 0 with the counts filled in, -1 with reason in err when
 * the session cannot start or nothing ran (a timeout with partial
 * progress is a 0 with the counts so far — the work already done
 * is real and the reply says so). via_relay (Phase 2) is threaded
 * to run_one_action so relay-driven actions are marked in the audit
 * log; it changes the marking only, never the grant decision. */
static int run_session(const char *backend_path, const char *task,
                       int timeout_s, size_t max_actions, int *allowed,
                       int *denied, int *failed, char *err,
                       size_t errcap, int via_relay,
                       char *backend_err, size_t backend_errcap)
{
    *allowed = *denied = *failed = 0;
    if (backend_err && backend_errcap > 0)
        backend_err[0] = '\0';
    int in_pipe[2], out_pipe[2];
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) {
        snprintf(err, errcap, "cannot create pipes");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(in_pipe[0]);
        close(in_pipe[1]);
        close(out_pipe[0]);
        close(out_pipe[1]);
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        close(in_pipe[1]);
        close(out_pipe[0]);
        dup2(in_pipe[0], STDIN_FILENO);
        dup2(out_pipe[1], STDOUT_FILENO);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0)
            dup2(nullfd, STDERR_FILENO);
        execl(backend_path, backend_path, (char *)NULL);
        _exit(127);
    }
    close(in_pipe[0]);
    close(out_pipe[1]);

    /* Session marker, then the task line. The backend reads the
     * marker first; a backend that does not understand sessions
     * would read "SESSION" as its task — but every shipped backend
     * is P1-aware, and ASK still sends the task directly. */
    char task_line[TASK_CAP + 2];
    snprintf(task_line, sizeof(task_line), "SESSION\n%s\n", task);
    if (write_all_quiet(in_pipe[1], task_line, strlen(task_line)) != 0) {
        close(in_pipe[1]);
        close(out_pipe[0]);
        int status = 0;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
        }
        snprintf(err, errcap, "backend closed stdin");
        return -1;
    }

    int rc = 0;
    char line[LINE_CAP];
    for (;;) {
        int done = *allowed + *denied + *failed;
        if (done >= (int)max_actions) {
            /* Cap reached: the session ends normally with the
             * counts so far — the backend proposed more than its
             * budget allows, and the work already done is real. */
            log_line("AID session action cap reached (%zu)",
                     max_actions);
            break;
        }
        int lr = read_line_deadline(out_pipe[0], line, sizeof(line),
                                    timeout_s);
        if (lr == 0)
            break; /* EOF: the backend left */
        if (lr == -1) {
            /* Per-action budget spent. With partial progress the
             * session is a success with the counts so far; with
             * nothing done it is a failure, like ASK. */
            if (done == 0) {
                snprintf(err, errcap, "backend timed out");
                rc = -1;
            } else {
                log_line("AID session timed out after %d actions",
                         done);
            }
            break;
        }
        if (lr == -2) {
            snprintf(err, errcap, "read failed: %s", strerror(errno));
            rc = -1;
            break;
        }
        if (strcmp(line, "END") == 0)
            break;
        if (line[0] == '\0')
            continue;
        struct action a;
        if (parse_action(line, &a) != 0) {
            if (strncmp(line, "ERR ", 4) == 0)
                stash_backend_err(backend_err, backend_errcap, line);
            continue; /* chatter, not an action */
        }
        char detail[256];
        int outcome = run_one_action(&a, detail, sizeof(detail),
                                     via_relay);
        if (outcome == 1)
            (*allowed)++;
        else if (outcome == 0)
            (*denied)++;
        else
            (*failed)++;
        /* The RESULT must be one line: an executor detail never
         * carries a newline, but strip one anyway so a future
         * detail cannot split the protocol. */
        for (char *p = detail; *p; p++) {
            if (*p == '\n' || *p == '\r')
                *p = ' ';
        }
        char result[512];
        snprintf(result, sizeof(result), "RESULT %s %s\n",
                 outcome == 1 ? "OK" : outcome == 0 ? "DENIED"
                                                     : "FAILED",
                 detail);
        /* A dead pipe (batch backend) is not an error: the actions
         * still ran, and the next read returns EOF. */
        (void)!write_all_quiet(in_pipe[1], result, strlen(result));
    }
    close(in_pipe[1]);
    close(out_pipe[0]);
    /* Bounded reap: a backend that printed END exits on its own;
     * one that is still waiting on stdin gets EOF and should exit
     * too. A hung backend is killed after 2 s — the daemon must
     * not block on it. */
    int status = 0;
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += 2;
    int reaped = 0;
    for (;;) {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) {
            reaped = 1;
            break;
        }
        if (w < 0 && errno != EINTR)
            break;
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec > deadline.tv_sec ||
            (now.tv_sec == deadline.tv_sec &&
             now.tv_nsec >= deadline.tv_nsec))
            break;
        struct timespec nap = { .tv_sec = 0, .tv_nsec = 50 * 1000000 };
        nanosleep(&nap, NULL);
    }
    if (!reaped) {
        kill(pid, SIGKILL);
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
        }
    }
    return rc;
}

/* ------------------------------------------------------------------ */
/* command handling                                                    */
/* ------------------------------------------------------------------ */

/* Run one verb. `reply` is called with the reply line for socket
 * clients (NULL for control-serial callers, whose replies go to the
 * console instead). Mirrors appd's run_verb. via_relay (Phase 2)
 * marks the client as the relay agent (detected at accept() from
 * the peer exe basename); it is threaded to the ASK/SESSION paths
 * for audit marking and, for SESSION, the ai.relay transitions.
 * The control-serial caller passes 0. */
typedef void (*reply_fn)(void *ctx, const char *line);

static void run_verb(const char *verb_line, reply_fn reply, void *ctx,
                     int from_ctl, int via_relay)
{
    /* TASK_CAP: the verb line may carry a 16 KiB ASK task. Replies
     * stay short (out is LINE_CAP). */
    char line[TASK_CAP];
    snprintf(line, sizeof(line), "%s", verb_line);
    char *sp = strchr(line, ' ');
    char *arg = NULL;
    if (sp) {
        *sp = '\0';
        arg = sp + 1;
        while (*arg == ' ')
            arg++;
        if (!*arg)
            arg = NULL;
    }
    char out[LINE_CAP];
    char backends[4096];
    char grant[4096];
    backends_csv(backends, sizeof(backends));
    grant_csv(grant, sizeof(grant));

    if (strcmp(line, "PING") == 0) {
        if (from_ctl)
            log_line("AID PONG");
        else if (reply)
            reply(ctx, "OK pong\n");
        return;
    }
    if (strcmp(line, "LIST") == 0) {
        scan_backends();
        backends_csv(backends, sizeof(backends));
        if (from_ctl)
            log_line("AID LIST selected=%s backends=%s", g_selected,
                     backends);
        else if (reply) {
            snprintf(out, sizeof(out), "OK selected=%s backends=%s\n",
                     g_selected, backends);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "SELECT") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("AID SELECT FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: SELECT <id>\n");
            return;
        }
        scan_backends();
        if (backend_index(arg) < 0) {
            if (from_ctl)
                log_line("AID SELECT FAIL unknown backend %s", arg);
            else if (reply) {
                snprintf(out, sizeof(out),
                         "ERR unknown backend %s\n", arg);
                reply(ctx, out);
            }
            return;
        }
        snprintf(g_selected, sizeof(g_selected), "%s", arg);
        if (save_selection() != 0)
            log_line("AID SELECT %s (selection NOT persisted)", arg);
        if (from_ctl)
            log_line("AID SELECT OK %s", arg);
        else if (reply) {
            snprintf(out, sizeof(out), "OK selected %s\n", arg);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "STATUS") == 0) {
        scan_backends();
        backends_csv(backends, sizeof(backends));
        /* Phase 2 relay: STATUS gains relay=<on|off|idle> — the
         * daemon's own view of the relay state (what the tray reads
         * via statusd). Additive, after god_mode. */
        if (from_ctl)
            log_line("AID STATUS selected=%s backends=%s grant=%s "
                     "god_mode=%s relay=%s",
                     g_selected, backends, grant,
                     g_god_mode ? "on" : "off", g_relay);
        else if (reply) {
            snprintf(out, sizeof(out),
                     "OK selected=%s backends=%s grant=%s god_mode=%s "
                     "relay=%s\n",
                     g_selected, backends, grant,
                     g_god_mode ? "on" : "off", g_relay);
            reply(ctx, out);
        }
        return;
    }
    /* RELOAD (P0): re-read the grant file so god mode can switch on
     * and off without a daemon restart. A failed reload keeps the
     * old grant — reload never fails open. */
    if (strcmp(line, "RELOAD") == 0) {
        if (reload_grant() == 0) {
            grant_csv(grant, sizeof(grant));
            if (from_ctl)
                log_line("AID RELOAD OK grant=%s", grant);
            else if (reply) {
                snprintf(out, sizeof(out),
                         "OK grant reloaded grant=%s\n", grant);
                reply(ctx, out);
            }
        } else {
            if (from_ctl)
                log_line("AID RELOAD FAIL keeping old grant");
            else if (reply)
                reply(ctx,
                      "ERR grant reload failed, keeping old grant\n");
        }
        return;
    }
    if (strcmp(line, "ASK") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("AID ASK FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: ASK <task>\n");
            return;
        }
        scan_backends();
        int bi = backend_index(g_selected);
        if (bi < 0) {
            if (from_ctl)
                log_line("AID ASK FAIL no backend selected");
            else if (reply)
                reply(ctx, "ERR no backend selected\n");
            return;
        }
        char backend_path[4096];
        snprintf(backend_path, sizeof(backend_path), "%s/%s",
                 g_backends_dir, g_backends[bi]);
        /* Per-backend limits (P0): muse-ai gets 300 s / 64 actions
         * from its .limits file; every other backend keeps 5 s / 32. */
        int timeout_s = BACKEND_TIMEOUT_S;
        size_t max_actions = MAX_ACTIONS;
        read_backend_limits(g_selected, &timeout_s, &max_actions);
        struct action *actions =
            calloc(max_actions, sizeof(struct action));
        if (!actions) {
            if (from_ctl)
                log_line("AID ASK FAIL out of memory");
            else if (reply)
                reply(ctx, "ERR out of memory\n");
            return;
        }
        size_t n_actions = 0;
        char err[256];
        char backend_err[BACKEND_ERR_CAP];
        if (run_backend(backend_path, arg, timeout_s, max_actions,
                        actions, &n_actions, err, sizeof(err),
                        backend_err, sizeof(backend_err)) != 0) {
            free(actions);
            if (from_ctl)
                log_line("AID ASK FAIL backend %s: %s", g_selected,
                         err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR backend %s failed: %s\n",
                         g_selected, err);
                reply(ctx, out);
            }
            return;
        }
        int allowed = 0, denied = 0, failed = 0;
        for (size_t i = 0; i < n_actions; i++) {
            char detail[256];
            int rc = run_one_action(&actions[i], detail,
                                    sizeof(detail), via_relay);
            if (rc == 1)
                allowed++;
            else if (rc == 0)
                denied++;
            else
                failed++;
        }
        free(actions);
        log_line("AID ASK backend=%s task=\"%s\" allowed=%d denied=%d "
                 "failed=%d",
                 g_selected, arg, allowed, denied, failed);
        if (from_ctl)
            log_line("AID ASK OK backend=%s allowed=%d denied=%d "
                     "failed=%d%s%s",
                     g_selected, allowed, denied, failed,
                     backend_err[0] ? " error=" : "", backend_err);
        else if (reply) {
            snprintf(out, sizeof(out),
                     "OK backend=%s allowed=%d denied=%d failed=%d%s%s\n",
                     g_selected, allowed, denied, failed,
                     backend_err[0] ? " error=" : "", backend_err);
            reply(ctx, out);
        }
        return;
    }
    /* SESSION (P1, §1.4.1, phase 2): an interactive agent loop —
     * the backend proposes one action, the daemon runs it and
     * reports the result, the backend re-plans (read -> fix ->
     * re-check). Same per-backend limits as ASK (D8: the timeout
     * becomes a per-action budget, not a whole-run deadline), same
     * grant checks at every step (run_one_action). Works on the
     * control serial too. */
    if (strcmp(line, "SESSION") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("AID SESSION FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: SESSION <task>\n");
            return;
        }
        scan_backends();
        int bi = backend_index(g_selected);
        if (bi < 0) {
            if (from_ctl)
                log_line("AID SESSION FAIL no backend selected");
            else if (reply)
                reply(ctx, "ERR no backend selected\n");
            return;
        }
        char backend_path[4096];
        snprintf(backend_path, sizeof(backend_path), "%s/%s",
                 g_backends_dir, g_backends[bi]);
        int timeout_s = BACKEND_TIMEOUT_S;
        size_t max_actions = MAX_ACTIONS;
        read_backend_limits(g_selected, &timeout_s, &max_actions);
        int allowed = 0, denied = 0, failed = 0;
        char err[256];
        char backend_err[BACKEND_ERR_CAP];
        /* Phase 2 relay (design §5.2): a SESSION from the relay
         * agent is a live remote session — ai.relay goes "on" for
         * the run and back to "idle" when it ends (success or
         * failure; the steady state after a session is idle). The
         * control-serial path passes via_relay 0, so it never
         * touches the key. */
        if (via_relay)
            relay_set_state("on");
        int ssrc = run_session(backend_path, arg, timeout_s, max_actions,
                               &allowed, &denied, &failed, err,
                               sizeof(err), via_relay,
                               backend_err, sizeof(backend_err));
        if (via_relay)
            relay_set_state("idle");
        if (ssrc != 0) {
            if (from_ctl)
                log_line("AID SESSION FAIL backend %s: %s", g_selected,
                         err);
            else if (reply) {
                snprintf(out, sizeof(out),
                         "ERR backend %s failed: %s\n", g_selected,
                         err);
                reply(ctx, out);
            }
            return;
        }
        /* Phase 2 relay (design §4.4): the SESSION console line
         * gains the same conditional field as the audit line, so
         * the harness and the console show which sessions came
         * over the relay. */
        log_line("AID SESSION backend=%s%s task=\"%s\" allowed=%d "
                 "denied=%d failed=%d",
                 g_selected, via_relay ? " via=relay" : "", arg,
                 allowed, denied, failed);
        if (from_ctl)
            log_line("AID SESSION OK backend=%s allowed=%d denied=%d "
                     "failed=%d%s%s",
                     g_selected, allowed, denied, failed,
                     backend_err[0] ? " error=" : "", backend_err);
        else if (reply) {
            snprintf(out, sizeof(out),
                     "OK backend=%s allowed=%d denied=%d failed=%d%s%s\n",
                     g_selected, allowed, denied, failed,
                     backend_err[0] ? " error=" : "", backend_err);
            reply(ctx, out);
        }
        return;
    }
    if (from_ctl)
        log_line("AID unknown command: %s", line);
    else if (reply)
        reply(ctx, "ERR unknown command\n");
}

/* ------------------------------------------------------------------ */
/* socket clients + main loop                                          */
/* ------------------------------------------------------------------ */

/* Phase 2 relay (INTERFACES.md): mark a client as relay-driven by
 * the peer process's exe basename — 1 iff it is "sevyn-relay".
 * SO_PEERCRED gives the peer pid; /proc/<pid>/exe gives its binary.
 * A marking signal only, not a security boundary: the grant is
 * enforced identically either way, and any root process could
 * already do anything. */
static int peer_via_relay(int fd)
{
    struct ucred cred;
    socklen_t len = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0)
        return 0;
    char exe[64];
    snprintf(exe, sizeof(exe), "/proc/%d/exe", (int)cred.pid);
    char target[4096];
    ssize_t n = readlink(exe, target, sizeof(target) - 1);
    if (n <= 0)
        return 0;
    target[n] = '\0';
    const char *base = strrchr(target, '/');
    base = base ? base + 1 : target;
    return strcmp(base, "sevyn-relay") == 0;
}

struct client {
    int fd;
    int dead;
    /* Phase 2 relay: 1 when the peer exe basename is "sevyn-relay"
     * (set at accept()); threaded to run_verb for audit marking
     * and the ai.relay transitions. */
    int via_relay;
    /* TASK_CAP: a client may send a 16 KiB ASK task line. */
    char in[TASK_CAP];
    size_t in_len;
};

#define MAX_CLIENTS_ARR MAX_CLIENTS
static struct client g_clients[MAX_CLIENTS];
static size_t g_nclients = 0;

static void socket_reply(void *ctx, const char *line)
{
    /* Replies are one short line; the client (the CLI) reads it and
     * closes. A blocking write is fine here — the peer is local and
     * the reply fits the socket buffer. */
    int fd = (int)(intptr_t)ctx;
    size_t n = strlen(line), off = 0;
    while (off < n) {
        ssize_t w = write(fd, line + off, n - off);
        if (w <= 0)
            break;
        off += (size_t)w;
    }
}

static void client_close(struct client *c)
{
    if (c->fd >= 0)
        close(c->fd);
    c->fd = -1;
    c->dead = 1;
}

static void compact_clients(void)
{
    size_t w = 0;
    for (size_t r = 0; r < g_nclients; r++) {
        if (!g_clients[r].dead) {
            if (w != r)
                g_clients[w] = g_clients[r];
            w++;
        }
    }
    g_nclients = w;
}

int main(void)
{
    g_sock_path = env_or("SEVYN_AI_SOCK", DEFAULT_SOCK);
    g_ctl_path = env_or("SEVYN_AI_CTL", DEFAULT_CTL);
    g_backends_dir = env_or("SEVYN_AI_BACKENDS_DIR", DEFAULT_BACKENDS_DIR);
    g_grant_path = env_or("SEVYN_AI_GRANT", DEFAULT_GRANT);
    g_selected_path = env_or("SEVYN_AI_SELECTED", DEFAULT_SELECTED);
    g_appd_sock = env_or("SEVYN_AI_APPD_SOCK", DEFAULT_APPD_SOCK);
    g_status_sock = env_or("SEVYN_AI_STATUS_SOCK", DEFAULT_STATUS_SOCK);
    g_cli_path = env_or("SEVYN_AI_CLI", DEFAULT_CLI);
    g_god_grant_path = env_or("SEVYN_AI_GOD_GRANT", DEFAULT_GOD_GRANT);
    g_god_marker_path = env_or("SEVYN_AI_GOD_MARKER", DEFAULT_GOD_MARKER);
    g_audit_path = env_or("SEVYN_AI_AUDIT_LOG", DEFAULT_AUDIT_LOG);
    g_relay_agent_marker_path =
        env_or("SEVYN_AI_RELAY_AGENT_MARKER", DEFAULT_RELAY_AGENT_MARKER);
    const char *read_root = getenv("SEVYN_AI_READ_ROOT");
    g_read_root = (read_root && *read_root) ? read_root : NULL;
    const char *write_root = getenv("SEVYN_AI_WRITE_ROOT");
    g_write_root = (write_root && *write_root) ? write_root : NULL;

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGHUP, on_sighup);
    signal(SIGPIPE, SIG_IGN);

    g_console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    if (g_console_fd < 0)
        g_console_fd = -1; /* stderr only (host test rig) */

    if (load_grant() != 0)
        return 1;

    /* God mode (P2, D2): the marker survives a reboot, so the mode
     * is evaluated here, at startup — a marker left on means the
     * daemon starts under the god grant, and logs
     * "AID god mode active", never silently. A broken standard
     * grant above already refused to start; god mode does not
     * rescue it. */
    eval_god_mode();

    /* AI relay (Phase 2, design §5.3/R6): when the agent marker
     * exists the relay is enabled for this boot — log it, never
     * silently, and mark the relay idle until a session starts.
     * The daemon never SETs "off" (the CLI sets it on disable;
     * statusd's default is off). */
    if (access(g_relay_agent_marker_path, F_OK) == 0) {
        log_line("AID relay enabled");
        relay_set_state("idle");
    }

    scan_backends();
    load_selection();
    if (backend_index(g_selected) < 0) {
        if (g_nbackends > 0) {
            log_line("AID selected backend %s not found; using %s",
                     g_selected, g_backends[0]);
            snprintf(g_selected, sizeof(g_selected), "%s",
                     g_backends[0]);
        } else {
            log_line("AID warning: no backends found in %s",
                     g_backends_dir);
        }
    }
    char backends[4096];
    backends_csv(backends, sizeof(backends));

    int listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        log_line("AID socket failed: %s", strerror(errno));
        return 1;
    }
    unlink(g_sock_path);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(g_sock_path) >= sizeof(addr.sun_path)) {
        log_line("AID socket path too long");
        return 1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", g_sock_path);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        log_line("AID bind failed: %s", strerror(errno));
        return 1;
    }
    if (listen(listen_fd, 8) != 0) {
        log_line("AID listen failed: %s", strerror(errno));
        return 1;
    }
    fcntl(listen_fd, F_SETFL, O_NONBLOCK);

    /* Control serial (read-only). Missing on the host test rig until
     * the harness creates it — retry for a while, then run without
     * it (the socket still serves the CLI). */
    int ctl_fd = -1;
    for (int i = 0; i < 50 && ctl_fd < 0 && !g_stop; i++) {
        ctl_fd = open(g_ctl_path, O_RDONLY | O_NONBLOCK);
        if (ctl_fd < 0)
            usleep(100 * 1000);
    }
    if (ctl_fd < 0)
        log_line("AID no control serial %s: %s (socket only)",
                 g_ctl_path, strerror(errno));

    log_line("AID ready sock=%s ctl=%s backends=%s selected=%s",
             g_sock_path, ctl_fd >= 0 ? g_ctl_path : "(none)",
             backends, g_selected);

    char ctl_buf[TASK_CAP];
    size_t ctl_len = 0;

    while (!g_stop) {
        /* SIGHUP asked for a grant reload (P0): re-read the grant
         * file. A failed reload keeps the old grant (reload_grant
         * logs it). Checked here, in the loop, because the signal
         * handler only sets the flag. */
        if (g_reload) {
            g_reload = 0;
            reload_grant();
        }
        struct pollfd pfds[2 + MAX_CLIENTS];
        int nfds = 0;
        pfds[nfds].fd = listen_fd;
        pfds[nfds].events = POLLIN;
        nfds++;
        if (ctl_fd >= 0) {
            pfds[nfds].fd = ctl_fd;
            pfds[nfds].events = POLLIN;
            nfds++;
        }
        for (size_t i = 0; i < g_nclients; i++) {
            pfds[nfds].fd = g_clients[i].fd;
            pfds[nfds].events = POLLIN;
            nfds++;
        }
        int r = poll(pfds, (nfds_t)nfds, 100);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        /* Clients accepted below were NOT in this poll() set: only
         * service the clients that were polled (the M3 lesson — a
         * fresh connection's slot holds stale revents). */
        size_t nclients_polled = g_nclients;
        int idx = 0;
        /* Listener. */
        if (pfds[idx].revents & POLLIN) {
            for (;;) {
                int cfd = accept(listen_fd, NULL, NULL);
                if (cfd < 0)
                    break;
                if (g_nclients >= MAX_CLIENTS) {
                    close(cfd);
                    continue;
                }
                struct client *c = &g_clients[g_nclients++];
                memset(c, 0, sizeof(*c));
                c->fd = cfd;
                c->via_relay = peer_via_relay(cfd);
            }
        }
        idx++;
        /* Control serial. */
        if (ctl_fd >= 0 && idx < nfds && (pfds[idx].revents & POLLIN)) {
            char tmp[1024];
            ssize_t nread = read(ctl_fd, tmp, sizeof(tmp));
            if (nread == 0) {
                /* Writer went away (EOF): close the fd so poll does
                 * not spin on it. The socket still serves the CLI. */
                log_line("AID control serial closed");
                close(ctl_fd);
                ctl_fd = -1;
            } else if (nread > 0) {
                for (ssize_t i = 0; i < nread; i++) {
                    char ch = tmp[i];
                    if (ch == '\n' || ch == '\r') {
                        if (ctl_len > 0) {
                            ctl_buf[ctl_len] = '\0';
                            run_verb(ctl_buf, NULL, NULL, 1, 0);
                            ctl_len = 0;
                        }
                    } else if (ctl_len + 1 < sizeof(ctl_buf)) {
                        ctl_buf[ctl_len++] = ch;
                    }
                }
            }
        }
        if (ctl_fd >= 0)
            idx++;
        /* Clients. */
        for (size_t i = 0; i < nclients_polled; i++) {
            struct client *c = &g_clients[i];
            if (c->dead)
                continue;
            short revents = pfds[idx + (int)i].revents;
            if (revents & (POLLERR | POLLHUP | POLLNVAL)) {
                client_close(c);
                continue;
            }
            if (revents & POLLIN) {
                char tmp[1024];
                ssize_t nread = read(c->fd, tmp, sizeof(tmp));
                if (nread <= 0) {
                    if (nread < 0 &&
                        (errno == EAGAIN || errno == EINTR)) {
                        /* try again next loop */
                    } else {
                        client_close(c);
                        continue;
                    }
                } else {
                    for (ssize_t j = 0; j < nread; j++) {
                        char ch = tmp[j];
                        if (ch == '\n' || ch == '\r') {
                            if (c->in_len > 0) {
                                c->in[c->in_len] = '\0';
                                run_verb(c->in, socket_reply,
                                         (void *)(intptr_t)c->fd, 0,
                                         c->via_relay);
                                c->in_len = 0;
                            }
                        } else if (c->in_len + 1 < sizeof(c->in)) {
                            c->in[c->in_len++] = ch;
                        }
                    }
                }
            }
        }
        compact_clients();
    }

    log_line("AID stopping");
    close(listen_fd);
    unlink(g_sock_path);
    if (ctl_fd >= 0)
        close(ctl_fd);
    return 0;
}
