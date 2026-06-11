import type { ContentFilterFallbackConfig } from "../../config"

/**
 * Fully-resolved, validated content-filter fallback config. Produced only when
 * the feature is enabled AND both models are present; otherwise the hook is a
 * no-op. Keeping the resolved shape non-optional lets the event handler avoid
 * defensive checks on every event.
 */
export type ResolvedContentFilterFallbackConfig = {
  /** Canonical source model id (`providerID/modelID`) whose content-filter finishes trigger fallback. */
  readonly fromModel: string
  /** Canonical fallback model id (`providerID/modelID`) used for the single retry. */
  readonly fallbackModel: string
  /** Emit a toast each time the fallback fires. */
  readonly notifyOnFallback: boolean
}

/**
 * Resolve the raw plugin config into a validated config, or `null` when the
 * feature is disabled / under-specified (missing source or fallback model).
 */
export function resolveContentFilterFallbackConfig(
  raw: ContentFilterFallbackConfig | undefined,
): ResolvedContentFilterFallbackConfig | null {
  if (!raw || raw.enabled !== true) {
    return null
  }
  const fromModel = typeof raw.from_model === "string" ? raw.from_model.trim() : ""
  const fallbackModel = typeof raw.fallback_model === "string" ? raw.fallback_model.trim() : ""
  if (!fromModel || !fallbackModel) {
    return null
  }
  return {
    fromModel,
    fallbackModel,
    notifyOnFallback: raw.notify_on_fallback ?? true,
  }
}
