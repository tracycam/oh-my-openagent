import { normalizeModelToCanonicalString } from "../runtime-fallback/normalize-model"

/**
 * Predicate for a content-filter fallback candidate.
 *
 * True only for an assistant message that finished with `content-filter`, has
 * NO error attached (it is a clean terminal finish), and whose model matches
 * the configured source model. `normalizeModelToCanonicalString` collapses both
 * the object form (`{ providerID, id|modelID }`) and the legacy string form,
 * covering both `info.model` shapes seen across opencode versions.
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
  return normalizeModelToCanonicalString(info.model) === fromModel
}
