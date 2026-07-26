export const RUNTIME_IDENTITY = Object.freeze({
  id: "org.sevynos.runtime",
  name: "Sevyn Runtime",
  architectureVersion: "0.1-genesis",
} as const);

export type RuntimeIdentity = typeof RUNTIME_IDENTITY;
