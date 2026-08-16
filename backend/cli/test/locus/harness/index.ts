/**
 * Harnais de conformance LEP.
 *
 * Il joue le **serveur** : `docs/10` §W2 fait de ce faux serveur ce contre quoi le worker
 * Canterel s'écrit, pour que le protocole doive être suffisant avant que `locusd` puisse
 * compenser ses lacunes.
 */
export { canonicalize, payloadHash } from "./canonical.ts";
export { runConformance, VERIFICATIONS, type Verification } from "./harness.ts";
export type { Session, WorkerUnderTest } from "./worker.ts";
