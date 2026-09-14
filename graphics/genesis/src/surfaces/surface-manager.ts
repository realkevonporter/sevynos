export interface GenesisSurface {
  readonly id: string;
  readonly applicationId: string;
  readonly sessionId: string;
}

export class SurfaceManager {
  private readonly surfaces = new Map<string, GenesisSurface>();

  public registerSurface(surface: GenesisSurface): void {
    if (this.surfaces.has(surface.id)) {
      throw new Error(`Surface "${surface.id}" is already registered.`);
    }

    this.surfaces.set(surface.id, surface);
  }

  public removeSurface(surfaceId: string): boolean {
    return this.surfaces.delete(surfaceId);
  }

  public getSurface(surfaceId: string): GenesisSurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  public getSurfaces(): readonly GenesisSurface[] {
    return [...this.surfaces.values()];
  }

  public hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  public clear(): void {
    this.surfaces.clear();
  }

  public get size(): number {
    return this.surfaces.size;
  }
}
