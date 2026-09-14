import { DisplayAlreadyExistsError } from "../errors/display-already-exists-error.js";
import { DisplayNotFoundError } from "../errors/display-not-found-error.js";
import type { DisplayId } from "./display-id.js";
import type { DisplayState } from "./display-state.js";
import type { GenesisDisplay } from "./genesis-display.js";

export class DisplayRegistry {
  readonly #displays = new Map<DisplayId, GenesisDisplay>();

  public add(display: GenesisDisplay): void {
    if (this.#displays.has(display.id)) {
      throw new DisplayAlreadyExistsError(display.id);
    }

    this.#displays.set(display.id, display);
  }

  public update(display: GenesisDisplay): void {
    if (!this.#displays.has(display.id)) {
      throw new DisplayNotFoundError(display.id);
    }

    this.#displays.set(display.id, display);
  }

  public remove(displayId: DisplayId): GenesisDisplay {
    const display = this.#displays.get(displayId);

    if (!display) {
      throw new DisplayNotFoundError(displayId);
    }

    this.#displays.delete(displayId);

    return display;
  }

  public get(displayId: DisplayId): GenesisDisplay | undefined {
    return this.#displays.get(displayId);
  }

  public has(displayId: DisplayId): boolean {
    return this.#displays.has(displayId);
  }

  public getPrimary(): GenesisDisplay | undefined {
    for (const display of this.#displays.values()) {
      if (display.primary) {
        return display;
      }
    }

    return undefined;
  }

  public list(): readonly GenesisDisplay[] {
    return [...this.#displays.values()];
  }

  public listByState(state: DisplayState): readonly GenesisDisplay[] {
    return this.list().filter((display) => display.state === state);
  }

  public count(): number {
    return this.#displays.size;
  }
}
