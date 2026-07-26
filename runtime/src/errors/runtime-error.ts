export abstract class RuntimeError extends Error {
  public abstract readonly code: string;

  protected constructor(message: string) {
    super(message);

    this.name = new.target.name;
  }
}
