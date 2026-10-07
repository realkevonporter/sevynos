/**
 * First-run onboarding state. The host persists a completion flag under the
 * "onboarding" persistence key (JSON in the genesis state directory); the
 * setup wizard runs exactly once per state directory.
 */
export interface OnboardingRecord {
  readonly setupComplete?: boolean | undefined;
  readonly completedAt?: string | undefined;
}

export function isOnboardingComplete(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { readonly setupComplete?: unknown }).setupComplete === true;
}

export function createOnboardingRecord(
  now: () => string = () => new Date().toISOString(),
): OnboardingRecord {
  return { setupComplete: true, completedAt: now() };
}
