// Type declarations for the RN audio module (plain JS,
// ./sevyn-audio.js). Apps import the adapters from here; the host
// functions they call are declared on the Sevyn global (see
// v2/shell/src/jsx.d.ts and v2/apps/src/jsx.d.ts).

export interface AudiodTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  path: string;
  format: string;
}

export interface AudiodStatus {
  playing: boolean;
  paused: boolean;
  currentPositionSec: number;
  durationSec: number;
  volume: number;
  track: AudiodTrack | null;
  available: boolean;
}

export interface AudiodOutput {
  id: string;
  name: string;
  isDefault: boolean;
  type: string;
}

export interface AudiodAdapter {
  play(source: string | { path: string; track?: AudiodTrack }): Promise<AudiodStatus>;
  pause(): Promise<AudiodStatus>;
  resume(): Promise<AudiodStatus>;
  stop(): Promise<AudiodStatus>;
  seek(seconds: number): Promise<AudiodStatus>;
  setVolume(volume: number): Promise<AudiodStatus>;
  status(): Promise<AudiodStatus>;
  scan(directory?: string): Promise<AudiodTrack[]>;
  getOutputs(): Promise<AudiodOutput[]>;
  setOutput(deviceId: string): Promise<null>;
}

/** A rejected audio call. `code` is stable — callers switch on it. */
export class AudiodError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

// The media adapter is the MediaService surface; audio carries the
// same playback surface for callers that think in output-device
// terms. One implementation under two names — never two.
export const SevynAudio: AudiodAdapter;
export const SevynMedia: AudiodAdapter;
