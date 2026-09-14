export type RenderScheduler = (render: () => void) => void;

export interface RenderInvalidator {
  readonly invalidate: () => void;
  readonly pending: boolean;
}

export function createRenderInvalidator(
  render: () => void,
  schedule: RenderScheduler,
): RenderInvalidator {
  let pending = false;

  return {
    get pending(): boolean {
      return pending;
    },

    invalidate(): void {
      if (pending) {
        return;
      }

      pending = true;

      schedule(() => {
        pending = false;
        render();
      });
    },
  };
}
