export interface DesktopRecoveryState {
  readonly active: boolean;
  readonly message: string;
}
export class DesktopRecoveryController {
  #state: DesktopRecoveryState = Object.freeze({ active: false, message: "" });
  readonly #notify: () => void;
  public constructor(notify: () => void) {
    this.#notify = notify;
  }
  public get state(): DesktopRecoveryState {
    return this.#state;
  }
  public enter(message: string): void {
    this.#state = Object.freeze({ active: true, message });
    this.#notify();
  }
  public clear(): void {
    this.#state = Object.freeze({ active: false, message: "" });
    this.#notify();
  }
}
