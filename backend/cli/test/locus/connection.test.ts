import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  attemptsToCeiling,
  httpEnrollmentTransport,
  reconnectDelay,
  type FetchLike,
} from "../../src/locus/connection.ts"
import { resolveConfig } from "../../src/locus/config.ts"
import { enroll } from "../../src/locus/auth.ts"
import { loadOrCreateIdentity } from "../../src/locus/identity.ts"
import { LocusServerRejected } from "../../src/locus/errors.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "locus-connection-"))

function respond(status: number, body: unknown = {}): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("transport d'enrôlement — §7.3", () => {
  test("une redirection est refusée, jamais suivie", async () => {
    // La leçon payée dans xiiif : suivre une redirection, c'est laisser le serveur choisir la
    // destination APRÈS que la politique a été appliquée à l'URL d'origine. Un token d'enrôlement
    // suit ce chemin.
    const identity = await loadOrCreateIdentity(scratch())
    const transport = httpEnrollmentTransport({
      endpoint: "https://locus.example",
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://ailleurs.example" } }),
    })
    await expect(enroll({ identity, endpoint: "https://locus.example", token: "t", transport })).rejects.toThrow()
  })

  test("`redirect: manual` est réellement demandé au fetch", async () => {
    // Sans lui, `fetch` suit par défaut et le refus ci-dessus ne se déclencherait jamais : la
    // réponse arriverait en 200 depuis l'hôte d'arrivée.
    let seen: RequestInit | undefined
    const transport = httpEnrollmentTransport({
      endpoint: "https://locus.example",
      fetch: async (_input, init) => {
        seen = init
        return new Response(JSON.stringify({ credential: "c" }), { status: 200 })
      },
    })
    await transport({} as never)
    expect(seen?.redirect).toBe("manual")
  })

  test("un endpoint non TLS hors boucle locale est refusé à la construction", () => {
    // Avant tout appel : le transport ne doit pas exister pour une destination que la politique
    // refuse.
    expect(() => httpEnrollmentTransport({ endpoint: "http://locus.example", fetch: respond(200) })).toThrow()
    expect(() => httpEnrollmentTransport({ endpoint: "http://127.0.0.1:7420", fetch: respond(200) })).not.toThrow()
  })

  test("le chemin appelé reste sur l'origine validée", async () => {
    let called = ""
    const transport = httpEnrollmentTransport({
      endpoint: "https://locus.example:8443",
      fetch: async (input) => {
        called = input
        return new Response(JSON.stringify({ credential: "c" }), { status: 200 })
      },
    })
    await transport({} as never)
    expect(new URL(called).origin).toBe("https://locus.example:8443")
    expect(new URL(called).pathname).toBe("/lep/v1/enroll")
  })

  test("une réponse en erreur devient un refus nommé", async () => {
    const transport = httpEnrollmentTransport({ endpoint: "https://locus.example", fetch: respond(503) })
    try {
      await transport({} as never)
      throw new Error("aurait dû refuser")
    } catch (error) {
      expect(LocusServerRejected.isInstance(error)).toBe(true)
    }
  })

  test("un appel qui pend est interrompu au lieu d'attendre indéfiniment", async () => {
    const transport = httpEnrollmentTransport({
      endpoint: "https://locus.example",
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    })
    await expect(transport({} as never)).rejects.toThrow()
  })
})

describe("reconnexion — §6", () => {
  const config = (over: Record<string, unknown> = {}) =>
    resolveConfig([{ name: "cli", values: { reconnect: { initial_ms: 500, max_ms: 30_000, ...over } } }])

  test("le délai croît exponentiellement et plafonne", () => {
    const flat = config({ jitter: false })
    expect(reconnectDelay(flat, 0)).toBe(500)
    expect(reconnectDelay(flat, 1)).toBe(1000)
    expect(reconnectDelay(flat, 3)).toBe(4000)
    // Le plafond de §6 est une limite écrite par l'opérateur, pas une suggestion.
    expect(reconnectDelay(flat, 20)).toBe(30_000)
  })

  test("la gigue tire vers le bas, jamais au-delà du plafond", () => {
    // Giguer vers le haut ferait dépasser `max_ms`, c'est-à-dire ignorer la seule limite écrite.
    const gigue = config({ jitter: true })
    expect(reconnectDelay(gigue, 20, () => 0)).toBe(15_000)
    expect(reconnectDelay(gigue, 20, () => 1)).toBe(30_000)
    for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = reconnectDelay(gigue, 20, () => draw)
      expect(delay).toBeLessThanOrEqual(30_000)
      expect(delay).toBeGreaterThanOrEqual(15_000)
    }
  })

  test("sans gigue, tout un parc revient en même temps", () => {
    // Le test dit pourquoi la gigue existe : deux workers sans elle produisent le même délai, et
    // remettent le serveur par terre au moment où il se relève.
    const flat = config({ jitter: false })
    expect(reconnectDelay(flat, 5)).toBe(reconnectDelay(flat, 5))

    const gigue = config({ jitter: true })
    expect(reconnectDelay(gigue, 5, () => 0)).not.toBe(reconnectDelay(gigue, 5, () => 1))
  })

  test("le nombre de tentatives avant plafond se rend compte", () => {
    expect(attemptsToCeiling(config())).toBe(6)
    expect(attemptsToCeiling(config({ initial_ms: 30_000 }))).toBe(0)
  })
})
