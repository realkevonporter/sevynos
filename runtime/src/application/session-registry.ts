import { ApplicationSessionNotFoundError } from "../errors/application-session-not-found-error.js";

import { ApplicationSession, type ApplicationSessionId } from "./application-session.js";
import type { ApplicationSessionState } from "./application-session-state.js";

export class SessionRegistry {
  readonly #sessions = new Map<ApplicationSessionId, ApplicationSession>();

  public add(session: ApplicationSession): void {
    if (this.#sessions.has(session.id)) {
      throw new Error(`Application session "${session.id}" is already registered.`);
    }

    this.#sessions.set(session.id, session);
  }

  public update(session: ApplicationSession): void {
    if (!this.#sessions.has(session.id)) {
      throw new ApplicationSessionNotFoundError(session.id);
    }

    this.#sessions.set(session.id, session);
  }

  public transition(
    sessionId: ApplicationSessionId,
    state: ApplicationSessionState,
  ): ApplicationSession {
    const currentSession = this.#sessions.get(sessionId);

    if (!currentSession) {
      throw new ApplicationSessionNotFoundError(sessionId);
    }

    const nextSession = currentSession.transitionTo(state);

    this.#sessions.set(sessionId, nextSession);

    return nextSession;
  }

  public get(sessionId: ApplicationSessionId): ApplicationSession | undefined {
    return this.#sessions.get(sessionId);
  }

  public has(sessionId: ApplicationSessionId): boolean {
    return this.#sessions.has(sessionId);
  }

  public remove(sessionId: ApplicationSessionId): boolean {
    return this.#sessions.delete(sessionId);
  }

  public list(): readonly ApplicationSession[] {
    return Array.from(this.#sessions.values());
  }

  public clear(): void {
    this.#sessions.clear();
  }
}
