/**
 * Type declarations for canonical.mjs (the JS signing-tooling side of the
 * canonical feed serialization). The implementation lives in canonical.mjs;
 * this file only types it for TypeScript consumers such as the parity test
 * in services/update/src/feed-signing.test.ts.
 */
export function canonicalFeedBody(manifest: object): string;
