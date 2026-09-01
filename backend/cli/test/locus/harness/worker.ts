import type { CapabilityManifest, Event, MissionEnvelope } from "../../../src/locus/lep/generated.ts";

/**
 * Le port qu'un worker sous test implémente.
 *
 * Volontairement sans transport. LEP nomme WebSocket comme référence et autorise un mode
 * pull/queue (§15.2) ; un harnais qui imposerait l'un des deux ne testerait pas le protocole mais
 * son enrobage. Ce qui est vérifié ici, c'est la séquence et le contenu — ce qui reste vrai quel
 * que soit le tuyau.
 */
export type WorkerUnderTest = {
  /** Ce que le worker annonce au handshake. */
  register(): Promise<CapabilityManifest> | CapabilityManifest;

  /**
   * Une offre de mission. Le worker accepte en rendant `true`, refuse en rendant `false`.
   *
   * Un refus n'est pas une faute : la politique locale d'un worker peut être plus restrictive que
   * son manifeste (`repos/canterel/SPEC_V1.md` §10.3), et un worker qui accepte tout ce qu'on lui
   * propose est le vrai défaut.
   */
  offer(mission: MissionEnvelope): Promise<boolean> | boolean;

  /**
   * Les événements que le worker émet depuis qu'il a accepté, dans l'ordre.
   *
   * Le harnais les consomme plutôt que de les attendre en temps réel : une conformance qui
   * dépendrait d'horloges serait un test intermittent, et un test intermittent finit désactivé.
   */
  events(): Promise<readonly Event[]> | readonly Event[];
};

/** Ce que le harnais a observé d'une session, pour que les vérifications le lisent. */
export type Session = {
  readonly manifest: CapabilityManifest;
  readonly mission: MissionEnvelope;
  readonly accepted: boolean;
  readonly events: readonly Event[];
};
