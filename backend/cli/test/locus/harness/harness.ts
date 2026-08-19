import type { Event, Lease, MissionEnvelope } from "../../../src/locus/lep/generated.ts";
import type { Finding } from "./findings.ts";
import type { Session, WorkerUnderTest } from "./worker.ts";
import { payloadHash } from "../../../src/locus/lep/canonical.ts";

/**
 * Le harnais de conformance LEP — il joue le SERVEUR.
 *
 * `docs/10` §W2 dit pourquoi : « écrire le worker contre un faux serveur oblige le protocole à
 * être suffisant avant que le vrai serveur puisse compenser ses lacunes ». Un worker testé contre
 * `locusd` hériterait de toutes les indulgences que `locusd` finira par accumuler ; ici il n'y a
 * personne pour compenser.
 *
 * Chaque vérification rend des `Finding`, jamais une exception. Un harnais qui s'arrête à la
 * première faute ne dit pas si les suivantes existent, et c'est le rapport complet qui permet de
 * juger si un worker est loin ou près de la conformité.
 */
export type Verification = {
  readonly id: string;
  readonly statement: string;
  readonly check: (session: Session, lease: Lease) => readonly Finding[];
};

/** Les événements dont l'ordre est imposé, et ce qui doit les précéder. */
const MUST_FOLLOW_START = new Set<string>([
  "progress",
  "tool.started",
  "tool.completed",
  "artifact.declared",
  "artifact.uploaded",
  "resource.sampled",
  "human.input.requested",
  "attempt.completed",
  "attempt.failed",
  "epistemic_commit.submitted",
]);

const TERMINAL = new Set<string>(["attempt.completed", "attempt.failed", "attempt.orphaned"]);

export const VERIFICATIONS: readonly Verification[] = [
  {
    id: "handshake-announces-real-levels",
    statement: "Le manifeste annonce des niveaux de sandbox et des modes réseau, non vides.",
    check: (session) => {
      const { levels, network_modes } = session.manifest.sandbox;
      const findings: Finding[] = [];
      if (levels.length === 0) {
        findings.push(finding("handshake", "sandbox.levels est vide : un worker sans niveau"));
      }
      if (network_modes.length === 0) {
        findings.push(finding("handshake", "sandbox.network_modes est vide"));
      }
      return findings;
    },
  },
  {
    id: "admission-refuses-what-it-cannot-hold",
    statement:
      "Un worker n'accepte pas une mission dont le plancher de sandbox dépasse ce qu'il offre.",
    check: (session) => {
      const required = session.mission.sandbox.minimum_level;
      const offered = session.manifest.sandbox.levels;
      if (session.accepted && !offered.includes(required)) {
        return [
          finding(
            "admission",
            `mission acceptée à ${required} alors que le worker n'offre que ${offered.join(", ")}` +
              " — c'est la faute que la paire de refus du corpus existe pour attraper",
          ),
        ];
      }
      return [];
    },
  },
  {
    id: "attempt-starts-before-it-reports",
    statement: "Aucun événement d'attempt ne précède `attempt.started`.",
    check: (session) => {
      const findings: Finding[] = [];
      let started = false;
      for (const event of session.events) {
        if (event.event_type === "attempt.started") started = true;
        else if (!started && MUST_FOLLOW_START.has(event.event_type)) {
          findings.push(
            finding("sequence", `${event.event_type} émis avant attempt.started`, event),
          );
        }
      }
      return findings;
    },
  },
  {
    id: "sequence-is-monotonic",
    statement: "Les numéros de séquence croissent strictement, hors rejeu.",
    check: (session) => {
      const findings: Finding[] = [];
      const seen = new Map<number, string>();
      let highest = -1;
      for (const event of session.events) {
        const previous = seen.get(event.sequence);
        if (previous !== undefined) {
          // Un rejeu porte la même séquence ET la même clé d'idempotence. Même séquence avec une
          // autre clé, c'est deux événements différents qui se disputent une place.
          if (previous !== event.idempotency_key) {
            findings.push(
              finding(
                "sequence",
                `séquence ${event.sequence} réutilisée avec une autre clé d'idempotence`,
                event,
              ),
            );
          }
          continue;
        }
        if (event.sequence <= highest) {
          findings.push(finding("sequence", `séquence ${event.sequence} après ${highest}`, event));
        }
        seen.set(event.sequence, event.idempotency_key);
        highest = Math.max(highest, event.sequence);
      }
      return findings;
    },
  },
  {
    id: "heartbeat-beats-often-enough",
    statement:
      "Le worker bat au moins trois fois par TTL de lease — la règle de §12.3 que Draft 7 ne sait pas exprimer.",
    check: (session, lease) => {
      // La dette héritée de W0.6 : « heartbeat à intervalle inférieur au tiers du TTL » est une
      // relation entre deux champs, hors de portée d'un schéma. Elle se vérifie ici.
      // `>=` et non `>` : §12.3 dit « à intervalle INFÉRIEUR au tiers du TTL », et un tiers
      // pile n'est pas inférieur à un tiers. Un worker qui bat exactement trois fois par TTL
      // n'a aucune marge — le premier battement en retard fait expirer la lease.
      if (lease.heartbeat_interval_seconds * 3 >= lease.ttl_seconds) {
        return [
          finding(
            "heartbeat",
            `intervalle de ${lease.heartbeat_interval_seconds}s pour un TTL de ` +
              `${lease.ttl_seconds}s : §12.3 exige strictement moins du tiers`,
          ),
        ];
      }
      const beats = session.events.filter((event) => event.event_type === "heartbeat").length;
      const terminal = session.events.some((event) => TERMINAL.has(event.event_type));
      if (terminal && beats === 0) {
        return [finding("heartbeat", "aucun heartbeat sur toute la durée de l'attempt")];
      }
      return [];
    },
  },
  {
    id: "payload-hash-is-canonical",
    statement: "Un `payload_hash` annoncé porte sur la forme canonique de la charge.",
    check: (session) => {
      const findings: Finding[] = [];
      for (const event of session.events) {
        if (event.payload_hash === undefined) continue;
        const expected = payloadHash(event.payload ?? {});
        if (event.payload_hash !== expected) {
          findings.push(
            finding(
              "payload-hash",
              `annoncé ${event.payload_hash}, canonique ${expected} — un hash calculé sur la ` +
                "sortie d'un sérialiseur diverge entre pairs conformes (W0.8)",
              event,
            ),
          );
        }
      }
      return findings;
    },
  },
  {
    id: "attempt-ends-once",
    statement: "Un attempt se termine une fois, et rien ne le suit.",
    check: (session) => {
      const findings: Finding[] = [];
      const terminals = session.events.filter((event) => TERMINAL.has(event.event_type));
      if (terminals.length > 1) {
        findings.push(
          finding("lifecycle", `${terminals.length} événements terminaux pour un seul attempt`),
        );
      }
      const index = session.events.findIndex((event) => TERMINAL.has(event.event_type));
      if (index >= 0) {
        for (const event of session.events.slice(index + 1)) {
          if (event.event_type !== terminals[0]?.event_type) {
            findings.push(
              finding("lifecycle", `${event.event_type} émis après la fin de l'attempt`, event),
            );
          }
        }
      }
      return findings;
    },
  },
  {
    id: "attempt-rank-matches-the-lease",
    statement: "Le rang d'attempt d'un événement est celui de la lease, jamais un autre nombre.",
    check: (session, lease) =>
      substitutions(session.events, "attempt", lease.attempt, (event) => event.attempt),
  },
  {
    id: "worker-id-matches-the-manifest",
    statement: "Le `worker_id` d'un événement est celui annoncé au handshake.",
    check: (session) =>
      substitutions(session.events, "worker_id", session.manifest.worker_id, (e) => e.worker_id),
  },
  {
    id: "task-id-matches-the-mission",
    statement: "Le `task_id` d'un événement est celui de la mission acceptée.",
    check: (session) =>
      substitutions(session.events, "task_id", session.mission.task_id, (e) => e.task_id),
  },
  {
    id: "late-result-declares-itself",
    statement:
      "Un attempt qui rend après l'expiration de sa lease le déclare, au lieu de le laisser deviner.",
    check: (session, lease) => {
      const completion = session.events.find((event) => event.event_type === "attempt.completed");
      if (!completion) return [];
      const expired = Date.parse(completion.occurred_at) > Date.parse(lease.expires_at);
      const declared = declaresLate(completion.payload);
      if (expired && !declared) {
        return [
          finding(
            "late-result",
            "rendu après l'expiration de la lease sans se déclarer tardif : §12.3 met le " +
              "résultat en quarantaine, encore faut-il savoir qu'il l'est",
            completion,
          ),
        ];
      }
      return [];
    },
  },
];

/**
 * Faire passer la conformance à un worker.
 *
 * Rend un rapport, pas un booléen : « non conforme » sans le détail n'est pas exploitable, et
 * c'est la liste des vérifications passées qui distingue « rien à signaler » de « rien vérifié ».
 */
export async function runConformance(
  worker: WorkerUnderTest,
  mission: MissionEnvelope,
  lease: Lease,
): Promise<{ readonly findings: readonly Finding[]; readonly ran: readonly string[] }> {
  const manifest = await worker.register();
  const accepted = await worker.offer(mission);
  const events = accepted ? await worker.events() : [];
  const session: Session = { manifest, mission, accepted, events };

  const findings: Finding[] = [];
  const ran: string[] = [];
  for (const verification of VERIFICATIONS) {
    ran.push(verification.id);
    findings.push(...verification.check(session, lease));
  }
  return { findings, ran };
}

/**
 * Les événements qui portent une identité **différente** de celle attendue.
 *
 * # Trois vérifications et non une
 *
 * §11.1 : « aucune de ces identités ne doit être substituée aux autres. » Une vérification unique
 * qui dirait « identités incohérentes » enverrait comparer trois paires à la main, et c'est
 * précisément le travail que la substitution rend difficile — les trois valeurs se ressemblent, ce
 * sont toutes des identifiants préfixés. Chaque identité a donc sa vérification, et chaque constat
 * **nomme** celle qui a été substituée.
 *
 * # Absent n'est pas substitué
 *
 * Les trois champs sont facultatifs dans le schéma de l'événement. Un champ absent n'est donc pas
 * une substitution : c'est une absence, et exiger sa présence ici ferait du harnais un vérificateur
 * de complétude que LEP ne demande pas. Les deux fautes ne se réparent pas pareil — l'une en
 * corrigeant une valeur, l'autre en décidant si le champ doit devenir obligatoire, ce qui est un
 * mineur de protocole.
 */
function substitutions<T>(
  events: readonly Event[],
  field: "attempt" | "worker_id" | "task_id",
  expected: T,
  read: (event: Event) => T | undefined,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    const actual = read(event);
    if (actual === undefined || actual === expected) continue;
    findings.push(
      finding(
        "identity",
        `${field} vaut ${String(actual)} alors que ${SOURCE[field]} dit ${String(expected)} — ` +
          "§11.1 : aucune de ces identités ne doit être substituée aux autres",
        event,
      ),
    );
  }
  return findings;
}

/** D'où vient l'identité de référence, pour que le constat dise où aller la relire. */
const SOURCE = {
  attempt: "la lease",
  worker_id: "le manifeste",
  task_id: "la mission",
} as const;

/**
 * `payload` est volontairement opaque dans le schéma — `{ "type": "object" }`, sans propriétés —
 * donc `unknown` dans le SDK. Le lire demande de vérifier sa forme plutôt que de la supposer.
 */
function declaresLate(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)["late"] === true
  );
}

function finding(rule: string, message: string, event?: Event): Finding {
  return {
    rule,
    where: event ? `${event.event_type}#${event.sequence}` : "session",
    message,
  };
}
