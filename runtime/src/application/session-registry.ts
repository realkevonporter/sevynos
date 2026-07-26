import type { ApplicationSession, ApplicationSessionId } from "./application-session.js";

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
      throw new Error(`Application session "${session.id}" is not registered.`);
    }

    this.#sessions.set(session.id, session);
  }

  public remove(id: ApplicationSessionId): boolean {
    return this.#sessions.delete(id);
  }

  public get(id: ApplicationSessionId): ApplicationSession | undefined {
    return this.#sessions.get(id);
  }

  public has(id: ApplicationSessionId): boolean {
    return this.#sessions.has(id);
  }

  public list(): readonly ApplicationSession[] {
    return [...this.#sessions.values()];
  }

  public clear(): void {
    this.#sessions.clear();
  }
}
