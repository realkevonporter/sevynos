import { DisplayNotFoundError } from "../errors/display-not-found-error.js";
import type { DisplayBounds } from "./display-bounds.js";
import type { DisplayId } from "./display-id.js";
import type { DisplayMode } from "./display-mode.js";
import type { DisplayOrientation } from "./display-orientation.js";
import type { DisplayRegistry } from "./display-registry.js";
import { GenesisDisplay } from "./genesis-display.js";

export interface ConnectDisplayRequest {
  readonly name: string;

  readonly bounds: DisplayBounds;

  readonly mode: DisplayMode;

  readonly scaleFactor: number;

  readonly orientation: DisplayOrientation;
}

export interface UpdateDisplayConfigurationRequest {
  readonly bounds?: DisplayBounds;

  readonly mode?: DisplayMode;

  readonly scaleFactor?: number;

  readonly orientation?: DisplayOrientation;
}

export interface GenesisDisplayManagerDependencies {
  readonly displays: DisplayRegistry;

  readonly createDisplayId: () => DisplayId;

  readonly now: () => Date;
}

export class GenesisDisplayManager {
  readonly #displays: DisplayRegistry;

  readonly #createDisplayId: () => DisplayId;

  readonly #now: () => Date;

  public constructor(dependencies: GenesisDisplayManagerDependencies) {
    this.#displays = dependencies.displays;

    this.#createDisplayId = dependencies.createDisplayId;

    this.#now = dependencies.now;
  }

  public connectDisplay(request: ConnectDisplayRequest): GenesisDisplay {
    const connectedAt = this.#now();

    const shouldBecomePrimary = this.#displays.getPrimary() === undefined;

    const display = new GenesisDisplay({
      id: this.#createDisplayId(),

      name: request.name,

      bounds: request.bounds,

      mode: request.mode,

      scaleFactor: request.scaleFactor,

      orientation: request.orientation,

      state: "connected",

      primary: shouldBecomePrimary,

      createdAt: connectedAt,

      updatedAt: connectedAt,
    });

    this.#displays.add(display);

    return display;
  }

  public getDisplay(displayId: DisplayId): GenesisDisplay {
    return this.#requireDisplay(displayId);
  }

  public getPrimaryDisplay(): GenesisDisplay | undefined {
    return this.#displays.getPrimary();
  }

  public listDisplays(): readonly GenesisDisplay[] {
    return this.#displays.list();
  }

  public listConnectedDisplays(): readonly GenesisDisplay[] {
    return this.#displays.list().filter((display) => display.state !== "disconnected");
  }

  public activateDisplay(displayId: DisplayId): GenesisDisplay {
    const display = this.#requireDisplay(displayId);

    const updated = display.withState("active", this.#now());

    if (updated === display) {
      return display;
    }

    this.#displays.update(updated);

    return updated;
  }

  public updateDisplayConfiguration(
    displayId: DisplayId,
    request: UpdateDisplayConfigurationRequest,
  ): GenesisDisplay {
    let display = this.#requireDisplay(displayId);

    const updatedAt = this.#now();

    if (request.bounds !== undefined) {
      display = display.withBounds(request.bounds, updatedAt);
    }

    if (request.mode !== undefined) {
      display = display.withMode(request.mode, updatedAt);
    }

    if (request.scaleFactor !== undefined) {
      display = display.withScaleFactor(request.scaleFactor, updatedAt);
    }

    if (request.orientation !== undefined) {
      display = display.withOrientation(request.orientation, updatedAt);
    }

    const existing = this.#requireDisplay(displayId);

    if (display === existing) {
      return existing;
    }

    this.#displays.update(display);

    return display;
  }

  public setPrimaryDisplay(displayId: DisplayId): GenesisDisplay {
    const target = this.#requireDisplay(displayId);

    if (target.state === "disconnected") {
      throw new Error(`Disconnected display "${displayId}" cannot become primary.`);
    }

    const currentPrimary = this.#displays.getPrimary();

    if (currentPrimary?.id === target.id) {
      return target;
    }

    const updatedAt = this.#now();

    if (currentPrimary) {
      this.#displays.update(currentPrimary.withPrimary(false, updatedAt));
    }

    const primary = target.withPrimary(true, updatedAt);

    this.#displays.update(primary);

    return primary;
  }

  public disconnectDisplay(displayId: DisplayId): GenesisDisplay {
    const display = this.#requireDisplay(displayId);

    if (display.state === "disconnected") {
      return display;
    }

    const updatedAt = this.#now();

    let disconnected = display;

    if (disconnected.primary) {
      disconnected = disconnected.withPrimary(false, updatedAt);
    }

    disconnected = disconnected.withState("disconnected", updatedAt);

    this.#displays.update(disconnected);

    if (display.primary) {
      this.#promoteReplacement(display.id, updatedAt);
    }

    return disconnected;
  }

  #promoteReplacement(
    disconnectedDisplayId: DisplayId,
    updatedAt: Date,
  ): GenesisDisplay | undefined {
    const candidates = this.#displays
      .list()
      .filter(
        (display) =>
          display.id !== disconnectedDisplayId && display.state !== "disconnected",
      );

    const replacement =
      candidates.find((display) => display.state === "active") ?? candidates[0];

    if (!replacement) {
      return undefined;
    }

    const primary = replacement.withPrimary(true, updatedAt);

    this.#displays.update(primary);

    return primary;
  }

  #requireDisplay(displayId: DisplayId): GenesisDisplay {
    const display = this.#displays.get(displayId);

    if (!display) {
      throw new DisplayNotFoundError(displayId);
    }

    return display;
  }
}
