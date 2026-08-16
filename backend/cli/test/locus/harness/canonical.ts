import { createHash } from "node:crypto";

/**
 * JSON canonique — les octets sur lesquels un hash porte.
 *
 * W0.8 a établi pourquoi il faut ça : la fixture écrit `"cpu": 4`, le schéma dit `number`, et le
 * SDK Rust ré-encode `4.0`. Deux pairs conformes émettent des octets différents pour la même
 * donnée. Calculer un `payload_hash` sur la sortie d'un sérialiseur les ferait diverger sur rien,
 * alors que §7.7 exige « une canonicalisation stable ».
 *
 * La forme suit RFC 8785 (JCS) sur les points qui comptent ici :
 *
 *  - les clés d'objet sont triées par leur code UTF-16, pas par l'ordre d'insertion ;
 *  - les nombres s'écrivent comme ECMAScript les écrit, donc `4.0` devient `4` ;
 *  - aucun espace insignifiant.
 *
 * Ce qui n'est PAS implémenté est refusé plutôt que rendu de travers : `NaN`, l'infini et les
 * entiers hors de la plage exacte de `double` lèvent une erreur. Un canonicaliseur qui rend
 * quelque chose pour une valeur qu'il ne sait pas représenter est pire qu'un qui s'arrête — le
 * premier produit un hash, et un hash faux ressemble en tout point à un hash juste.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`valeur non représentable en JSON : ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` n'existe pas en JSON ; le laisser passer produirait `"k":undefined`.
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * `4.0` → `4`, `1e21` → `1e+21`.
 *
 * `String(number)` en JavaScript EST la sérialisation qu'impose JCS. Ce n'est pas une commodité :
 * c'est la même règle des deux côtés du fil, ce qui est tout l'intérêt.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${value} n'a pas de représentation JSON`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${value} est hors de la plage où un entier survit à un aller-retour en double`,
    );
  }
  return String(value);
}

/**
 * Le hash d'une charge utile, préfixé par son algorithme.
 *
 * Le préfixe est la même exigence que dans le vocabulaire des schémas : un hash nu ne dit pas
 * comment le recalculer.
 */
export function payloadHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}
