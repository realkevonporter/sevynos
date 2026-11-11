// SevynOS v2 M10 — the comms apps: Messages, Video Calls, Voice Calls.
//
// One bundle, three apps: the identity comes from Sevyn.appId at
// runtime (the same one-bundle-many-manifests pattern as the M3
// template). The apps are thin UI over `sevyn comms` (commsd owns
// the Matrix account, E2EE crypto, and call signaling). Names are
// WORKING TITLES — Kevon picks the final names later.
//
//   messages    — the iMessage equivalent: rooms, threads, send.
//   video-calls — the FaceTime equivalent: video calls.
//   voice-calls — the FaceTime Audio equivalent: voice-only calls.
//
// The renderer is synchronous and the apps have no timers (the
// established pattern): reads happen on mount and on explicit
// Refresh, and after every action (login/send/answer/hangup).
// Incoming messages and calls appear on Refresh — a poll timer is
// follow-up work, not M10.
//
// Login: Matrix ID + password + homeserver (default matrix.org).
// The password travels on the `sevyn comms login` command line
// (root-only visibility, the same precedent as `sevyn files write`);
// commsd stores the token at /data/comms/account.json (0600) and
// never logs it. Passwords may contain spaces — the daemon parses
// LOGIN as <user> <password...> [homeserver-url].
//
// RCS: Messages shows the staged state honestly ("carrier setup
// required") — real RCS needs a carrier deal + a SIM-bearing mobile
// device (Kevon's call, see M10_PLAN.md §8).

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import { runCli, runCliAsync } from "./cli";

// Double-quote one CLI argument (the host's tokenizer strips the
// quotes and unescapes \" / \\, so values with spaces pass through
// intact — same helper as Settings).
function q(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

type Room = {
  roomId: string;
  name: string;
  encrypted: boolean;
  members: string[];
  lastMessage: { sender: string; body: string; ts: number } | null;
};
type Msg = {
  eventId: string;
  sender: string;
  type: string;
  encrypted: boolean;
  decrypted: boolean;
  body: string | null;
  ts: number;
};
type Call = {
  callId: string;
  roomId: string;
  peer: string | null;
  video: boolean;
  direction: string;
  state: string;
  media: string;
};
type Status = {
  loggedIn: boolean;
  userId: string | null;
  homeserver: string;
  deviceId: string | null;
  rooms: number;
  calls: Call[];
  bridge: string;
};

function cliJson<T>(cmd: string): T | null {
  const { code, out } = runCli(cmd);
  if (code !== 0) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

async function cliJsonAsync<T>(cmd: string): Promise<T | null> {
  const { code, out } = await runCliAsync(cmd);
  if (code !== 0) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function readStatus(): Status | null {
  return cliJson<Status>("sevyn comms status");
}

function readRooms(): Room[] {
  const data = cliJson<{ rooms: Room[] }>("sevyn comms rooms");
  return data ? data.rooms : [];
}

function readCalls(): Call[] {
  const data = cliJson<{ calls: Call[] }>("sevyn comms calls");
  return data ? data.calls : [];
}

function readMessages(roomId: string): Msg[] {
  const data = cliJson<{ messages: Msg[] }>("sevyn comms messages " + q(roomId) + " 20");
  return data ? data.messages : [];
}

function readRcs(): { staged: boolean; state: string; detail: string } | null {
  return cliJson<{ staged: boolean; state: string; detail: string }>(
    "sevyn comms rcs status",
  );
}

const S = {
  page: { flex: 1, backgroundColor: "#f9fafb", padding: 20 } as const,
  title: { fontSize: 26, fontWeight: "700", color: "#111827", marginBottom: 4 } as const,
  sub: { fontSize: 14, color: "#6b7280", marginBottom: 16 } as const,
  section: {
    fontSize: 13,
    fontWeight: "700",
    color: "#374151",
    marginTop: 18,
    marginBottom: 8,
  } as const,
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  } as const,
  row: { flexDirection: "row", alignItems: "center" } as const,
  name: { fontSize: 16, fontWeight: "600", color: "#111827" } as const,
  body: { fontSize: 14, color: "#374151", marginTop: 2 } as const,
  meta: { fontSize: 12, color: "#9ca3af", marginTop: 2 } as const,
  input: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: "#111827",
    marginBottom: 10,
  } as const,
  button: {
    backgroundColor: "#22c55e",
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
    marginTop: 4,
  } as const,
  buttonText: { color: "#ffffff", fontSize: 15, fontWeight: "600" } as const,
  ghost: {
    backgroundColor: "#e5e7eb",
    borderRadius: 10,
    padding: 10,
    alignItems: "center",
    marginTop: 8,
  } as const,
  ghostText: { color: "#111827", fontSize: 14, fontWeight: "600" } as const,
  danger: { backgroundColor: "#dc2626" } as const,
  error: { fontSize: 14, color: "#dc2626", marginTop: 8 } as const,
  note: { fontSize: 13, color: "#6b7280", marginTop: 12 } as const,
  bubbleMe: {
    backgroundColor: "#22c55e",
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    alignSelf: "flex-end",
    maxWidth: "85%",
  } as const,
  bubbleThem: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    alignSelf: "flex-start",
    maxWidth: "85%",
  } as const,
  bubbleTextMe: { color: "#ffffff", fontSize: 15 } as const,
  bubbleTextThem: { color: "#111827", fontSize: 15 } as const,
  sender: { fontSize: 12, color: "#6b7280", marginBottom: 2 } as const,
};

function LoginForm(props: {
  onLoggedIn: (userId: string) => void;
  setError: (s: string) => void;
}): React.ReactElement {
  const [user, setUser] = React.useState<string>("");
  const [password, setPassword] = React.useState<string>("");
  const [homeserver, setHomeserver] = React.useState<string>("https://matrix.org");
  const [busy, setBusy] = React.useState<boolean>(false);

  async function login(): Promise<void> {
    if (!user || !password) {
      props.setError("Enter your Matrix ID and password.");
      return;
    }
    setBusy(true);
    props.setError("");
    const cmd =
      "sevyn comms login " +
      q(user) +
      " " +
      q(password) +
      " " +
      q(homeserver || "https://matrix.org");
    const data = await cliJsonAsync<{ userId: string }>(cmd);
    setBusy(false);
    if (!data || !data.userId) {
      props.setError("Login failed — check the Matrix ID, password, and homeserver.");
      return;
    }
    Sevyn.log("COMMS login=" + data.userId);
    props.onLoggedIn(data.userId);
  }

  return (
    <View>
      <Text style={S.section}>LOG IN WITH MATRIX</Text>
      <View style={S.card}>
        <TextInput
          style={S.input}
          placeholder="@you:matrix.org"
          value={user}
          onChangeText={setUser}
        />
        <TextInput
          style={S.input}
          placeholder="Password"
          secureTextEntry={true}
          value={password}
          onChangeText={setPassword}
        />
        <TextInput
          style={S.input}
          placeholder="https://matrix.org"
          value={homeserver}
          onChangeText={setHomeserver}
        />
        <Pressable style={S.button} onPress={login}>
          <Text style={S.buttonText}>{busy ? "Logging in…" : "Log in"}</Text>
        </Pressable>
        <Text style={S.note}>
          Your own Matrix account — messages are end-to-end encrypted. The account stays
          on this device until you log out.
        </Text>
      </View>
    </View>
  );
}

export function Comms(): React.ReactElement {
  const mode = Sevyn.appId; // messages | video-calls | voice-calls
  const isCalls = mode === "video-calls" || mode === "voice-calls";
  const wantVideo = mode === "video-calls";
  const title =
    mode === "messages" ? "Messages" : wantVideo ? "Video Calls" : "Voice Calls";
  const [status, setStatus] = React.useState<Status | null>(() => {
    const st = readStatus();
    Sevyn.log("COMMS app=" + mode + " loggedIn=" + (st && st.loggedIn ? "yes" : "no"));
    return st;
  });
  const [rooms, setRooms] = React.useState<Room[]>(() => readRooms());
  const [calls, setCalls] = React.useState<Call[]>(() => readCalls());
  const [roomId, setRoomId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [draft, setDraft] = React.useState<string>("");
  const [target, setTarget] = React.useState<string>("");
  const [error, setError] = React.useState<string>("");
  const [rcs, setRcs] = React.useState(() => readRcs());

  function refresh(): void {
    const st = readStatus();
    setStatus(st);
    if (st && st.loggedIn) {
      const rs = readRooms();
      setRooms(rs);
      Sevyn.log("COMMS rooms=" + rs.length);
      setCalls(readCalls());
      if (roomId) setMessages(readMessages(roomId));
    }
  }

  function onLoggedIn(userId: string): void {
    setStatus(readStatus());
    const rs = readRooms();
    setRooms(rs);
    Sevyn.log("COMMS rooms=" + rs.length);
    setCalls(readCalls());
  }

  async function logout(): Promise<void> {
    await runCliAsync("sevyn comms logout");
    setStatus(readStatus());
    setRooms([]);
    setCalls([]);
    setRoomId(null);
    setMessages([]);
    Sevyn.log("COMMS logout");
  }

  function openRoom(id: string): void {
    setRoomId(id);
    setMessages(readMessages(id));
  }

  async function send(): Promise<void> {
    if (!roomId || !draft.trim()) return;
    const text = draft;
    setDraft("");
    const data = await cliJsonAsync<{ eventId: string }>(
      "sevyn comms send " + q(roomId) + " " + q(text),
    );
    if (!data || !data.eventId) {
      setError("Could not send — try Refresh, then send again.");
      setDraft(text);
      return;
    }
    Sevyn.log("COMMS sent room=" + roomId);
    setMessages(readMessages(roomId));
  }

  async function startCall(): Promise<void> {
    if (!target.trim()) {
      setError("Enter a Matrix ID or room ID to call.");
      return;
    }
    setError("");
    const flag = wantVideo ? "--video" : "--audio";
    const data = await cliJsonAsync<Call>(
      "sevyn comms call " + q(target.trim()) + " " + flag,
    );
    if (!data || !data.callId) {
      setError("Could not start the call.");
      return;
    }
    Sevyn.log("COMMS call=" + data.callId + " state=" + data.state);
    setCalls(readCalls());
  }

  async function answer(callId: string): Promise<void> {
    const data = await cliJsonAsync<Call>("sevyn comms answer " + q(callId));
    if (!data) {
      setError("Could not answer the call.");
      return;
    }
    Sevyn.log("COMMS call=" + callId + " state=" + data.state);
    setCalls(readCalls());
  }

  async function hangup(callId: string): Promise<void> {
    const data = await cliJsonAsync<Call>("sevyn comms hangup " + q(callId));
    if (!data) {
      setError("Could not hang up.");
      return;
    }
    Sevyn.log("COMMS call=" + callId + " state=" + data.state);
    setCalls(readCalls());
  }

  const live = calls.filter(
    (c) => c.state === "incoming" || c.state === "ringing" || c.state === "connected",
  );
  const incoming = calls.find((c) => c.state === "incoming");
  const active = calls.find((c) => c.state === "connected" || c.state === "ringing");

  return (
    <ScrollView style={S.page}>
      <Text style={S.title}>{title}</Text>
      <Text style={S.sub}>
        {isCalls
          ? wantVideo
            ? "Video calls over Matrix — SevynOS to SevynOS."
            : "Voice calls over Matrix — SevynOS to SevynOS."
          : "Messages over Matrix — end-to-end encrypted."}
      </Text>

      {!status || !status.loggedIn ? (
        <LoginForm onLoggedIn={onLoggedIn} setError={setError} />
      ) : (
        <View>
          <Text style={S.meta}>
            Logged in as {status.userId} · {status.homeserver}
          </Text>
          <Pressable style={S.ghost} onPress={refresh}>
            <Text style={S.ghostText}>Refresh</Text>
          </Pressable>

          {isCalls ? (
            <View>
              {incoming ? (
                <View style={S.card}>
                  <Text style={S.name}>
                    Incoming {incoming.video ? "video" : "voice"} call
                  </Text>
                  <Text style={S.body}>From {incoming.peer || "unknown"}</Text>
                  <Pressable style={S.button} onPress={() => answer(incoming.callId)}>
                    <Text style={S.buttonText}>Answer</Text>
                  </Pressable>
                  <Pressable
                    style={[S.ghost, S.danger]}
                    onPress={() => hangup(incoming.callId)}
                  >
                    <Text style={[S.ghostText, { color: "#ffffff" }]}>Decline</Text>
                  </Pressable>
                </View>
              ) : null}
              {active && !incoming ? (
                <View style={S.card}>
                  <Text style={S.name}>
                    {active.video ? "Video call" : "Voice call"} — {active.state}
                  </Text>
                  <Text style={S.body}>With {active.peer || "unknown"}</Text>
                  <Text style={S.meta}>
                    {active.media === "connected"
                      ? "Media connected"
                      : active.media === "connecting"
                        ? "Connecting media…"
                        : "No media yet"}
                  </Text>
                  {wantVideo ? (
                    <Text style={S.note}>
                      Video shows in the call window (Chromium) — this window holds the
                      controls.
                    </Text>
                  ) : null}
                  <Pressable
                    style={[S.ghost, S.danger]}
                    onPress={() => hangup(active.callId)}
                  >
                    <Text style={[S.ghostText, { color: "#ffffff" }]}>Hang up</Text>
                  </Pressable>
                </View>
              ) : null}
              {!incoming && !active ? (
                <View>
                  <Text style={S.section}>START A CALL</Text>
                  <View style={S.card}>
                    <TextInput
                      style={S.input}
                      placeholder="@friend:matrix.org or room ID"
                      value={target}
                      onChangeText={setTarget}
                    />
                    <Pressable style={S.button} onPress={startCall}>
                      <Text style={S.buttonText}>
                        Call {wantVideo ? "(video)" : "(voice)"}
                      </Text>
                    </Pressable>
                    <Text style={S.note}>
                      Calls go to SevynOS users and Element Web/Desktop. Element X uses
                      MatrixRTC, which needs a LiveKit server — not in this milestone.
                    </Text>
                  </View>
                  {calls.length > 0 ? (
                    <View>
                      <Text style={S.section}>RECENT CALLS</Text>
                      {calls.slice(-5).map((c) => (
                        <View key={c.callId} style={S.card}>
                          <Text style={S.name}>
                            {c.video ? "Video" : "Voice"} · {c.state}
                          </Text>
                          <Text style={S.meta}>
                            {c.direction} · {c.peer || c.roomId}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : roomId ? (
            <View>
              <Pressable style={S.ghost} onPress={() => setRoomId(null)}>
                <Text style={S.ghostText}>← All conversations</Text>
              </Pressable>
              <Text style={S.section}>
                {(rooms.find((r) => r.roomId === roomId) || { name: roomId }).name}
              </Text>
              {messages.length === 0 ? (
                <Text style={S.note}>No messages yet.</Text>
              ) : (
                messages.map((m) => {
                  const mine = m.sender === status.userId;
                  return (
                    <View key={m.eventId} style={mine ? S.bubbleMe : S.bubbleThem}>
                      {!mine ? <Text style={S.sender}>{m.sender}</Text> : null}
                      <Text style={mine ? S.bubbleTextMe : S.bubbleTextThem}>
                        {m.body ?? (m.encrypted ? "Encrypted — still decrypting…" : "")}
                      </Text>
                    </View>
                  );
                })
              )}
              <TextInput
                style={S.input}
                placeholder="Write a message…"
                value={draft}
                onChangeText={setDraft}
              />
              <Pressable style={S.button} onPress={send}>
                <Text style={S.buttonText}>Send</Text>
              </Pressable>
            </View>
          ) : (
            <View>
              <Text style={S.section}>CONVERSATIONS</Text>
              {rooms.length === 0 ? (
                <Text style={S.note}>
                  No conversations yet — they appear here after your first sync. Tap
                  Refresh if you just logged in.
                </Text>
              ) : (
                rooms.map((r) => (
                  <Pressable
                    key={r.roomId}
                    style={S.card}
                    onPress={() => openRoom(r.roomId)}
                  >
                    <Text style={S.name}>
                      {r.name}
                      {r.encrypted ? " · encrypted" : ""}
                    </Text>
                    {r.lastMessage ? (
                      <Text style={S.body} numberOfLines={1}>
                        {r.lastMessage.body}
                      </Text>
                    ) : (
                      <Text style={S.meta}>No messages yet</Text>
                    )}
                  </Pressable>
                ))
              )}
              {rcs ? (
                <View>
                  <Text style={S.section}>TEXTING IPHONES (RCS)</Text>
                  <View style={S.card}>
                    <Text style={S.name}>RCS — carrier setup required</Text>
                    <Text style={S.body}>{rcs.detail}</Text>
                  </View>
                </View>
              ) : null}
            </View>
          )}

          <Pressable style={S.ghost} onPress={logout}>
            <Text style={S.ghostText}>Log out</Text>
          </Pressable>
        </View>
      )}
      {error ? <Text style={S.error}>{error}</Text> : null}
      <Text style={S.note}>
        Working titles — Kevon picks the final app names. Calls to Element X need
        MatrixRTC + LiveKit (a later milestone).
      </Text>
    </ScrollView>
  );
}
