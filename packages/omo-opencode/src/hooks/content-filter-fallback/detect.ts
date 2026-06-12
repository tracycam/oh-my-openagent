import { normalizeModelToCanonicalString } from "../runtime-fallback/normalize-model"

/**
 * Resolve the canonical `provider/model` string from an assistant message
 * `info`, tolerating BOTH opencode shapes:
 *   - object/string: `info.model` = `{ providerID, id|modelID }` or a plain string
 *   - flat: `info.providerID` + `info.modelID` with NO `info.model` (the shape the
 *     opencode provider actually persists for a content-filter finish)
 * The flat shape is the real production case; without it the predicate silently
 * never matches and no fallback fires.
 */
function resolveCanonicalModel(info: Record<string, unknown>): string | undefined {
  const fromModelField = normalizeModelToCanonicalString(info.model)
  if (fromModelField) {
    return fromModelField
  }
  const providerID = typeof info.providerID === "string" ? info.providerID.trim() : undefined
  const modelID = typeof info.modelID === "string" ? info.modelID.trim() : undefined
  if (providerID && modelID) {
    return `${providerID}/${modelID}`
  }
  return undefined
}

/**
 * Predicate for a content-filter fallback candidate.
 *
 * True only for an assistant message that finished with `content-filter`, has
 * NO error attached (it is a clean terminal finish), and whose model matches
 * the configured source model. `resolveCanonicalModel` collapses the object
 * form, the legacy string form, AND the flat `providerID`/`modelID` form so the
 * predicate matches regardless of how opencode expresses the model.
 */
export function isContentFilterFallbackCandidate(
  info: Record<string, unknown> | undefined,
  fromModel: string,
): boolean {
  if (!info) {
    return false
  }
  if (info.role !== "assistant") {
    return false
  }
  if (info.finish !== "content-filter") {
    return false
  }
  if (info.error) {
    return false
  }
  return resolveCanonicalModel(info) === fromModel
}
