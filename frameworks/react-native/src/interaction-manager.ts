/**
 * Upstream React Native InteractionManager implementation.
 * Allows long-running tasks to be scheduled after any interactions/animations have finished.
 */

export interface TaskPromise<T> extends Promise<T | undefined> {
  cancel(): void;
  done?(
    onFulfilled?: (value?: T) => unknown,
    onRejected?: (reason?: unknown) => unknown,
  ): void;
}

export type InteractionEventListener = () => void;

class SevynInteractionManager {
  #nextHandle = 1;
  #activeHandles = new Set<number>();
  #startListeners = new Set<InteractionEventListener>();
  #completeListeners = new Set<InteractionEventListener>();
  #pendingTasks: {
    task?: (() => unknown) | undefined;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    cancelled: boolean;
  }[] = [];

  public createInteractionHandle(): number {
    const handle = this.#nextHandle++;
    const wasEmpty = this.#activeHandles.size === 0;
    this.#activeHandles.add(handle);
    if (wasEmpty) {
      for (const listener of this.#startListeners) {
        try {
          listener();
        } catch {
          // Ignore listener errors
        }
      }
    }
    return handle;
  }

  public clearInteractionHandle(handle: number): void {
    if (this.#activeHandles.delete(handle)) {
      if (this.#activeHandles.size === 0) {
        for (const listener of this.#completeListeners) {
          try {
            listener();
          } catch {
            // Ignore listener errors
          }
        }
        queueMicrotask(() => {
          this.#flushTasks();
        });
      }
    }
  }

  public runAfterInteractions<T>(task?: () => T): TaskPromise<T> {
    let cancelFn = (): void => undefined;

    const promise = new Promise<T | undefined>((resolve, reject) => {
      const record = {
        task: task as (() => unknown) | undefined,
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: false,
      };

      cancelFn = () => {
        record.cancelled = true;
      };

      if (this.#activeHandles.size === 0) {
        queueMicrotask(() => {
          if (!record.cancelled) {
            try {
              const result = record.task ? record.task() : undefined;
              record.resolve(result);
            } catch (error) {
              record.reject(error);
            }
          }
        });
      } else {
        this.#pendingTasks.push(record);
      }
    }) as TaskPromise<T>;

    promise.cancel = cancelFn;
    promise.done = (onFulfilled, onRejected) => {
      promise.then(
        (val) => onFulfilled?.(val),
        (err: unknown) => onRejected?.(err),
      );
    };

    return promise;
  }

  public addListener(
    event: "interactionStart" | "interactionComplete",
    listener: InteractionEventListener,
  ): { remove: () => void } {
    const set =
      event === "interactionStart" ? this.#startListeners : this.#completeListeners;
    set.add(listener);
    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  #flushTasks(): void {
    if (this.#activeHandles.size > 0) return;
    const tasks = this.#pendingTasks.splice(0, this.#pendingTasks.length);
    for (const record of tasks) {
      if (!record.cancelled) {
        try {
          const result = record.task ? record.task() : undefined;
          record.resolve(result);
        } catch (error) {
          record.reject(error);
        }
      }
    }
  }

  public get activeCount(): number {
    return this.#activeHandles.size;
  }
}

export const InteractionManager = Object.freeze(new SevynInteractionManager());
