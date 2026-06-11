import { z } from "zod"

/**
 * Content-Filter Fallback - single-shot model fallback on a `content-filter`
 * terminal finish.
 *
 * Distinct from `runtime_fallback` (error-driven, retryable HTTP codes) and
 * `model_fallback` (permanent fallback chain). A `content-filter` finish is a
 * clean terminal completion with no error event, so neither of those systems
 * ever sees it. This feature watches for `finish: "content-filter"` from a
 * specific source model and re-prompts the SAME turn exactly once on a
 * configured fallback model, WITHOUT changing the session's persistent model
 * (the next turn returns to the source model).
 */
export const ContentFilterFallbackConfigSchema = z.object({
  /** Enable content-filter single-shot fallback (default: false) */
  enabled: z.boolean().optional(),
  /**
   * Canonical source model id (`providerID/modelID`) whose `content-filter`
   * finishes trigger the fallback. Only turns produced by this model are
   * eligible (e.g. "opencode/claude-fable-5").
   */
  from_model: z.string().optional(),
  /**
   * Canonical fallback model id (`providerID/modelID`) used for the single
   * retry of the filtered turn (e.g. "bailian-token-plan/qwen3.7-max"). This
   * model is authoritative for the retry; the source agent's variant/reasoning
   * settings are NOT inherited.
   */
  fallback_model: z.string().optional(),
  /** Show a toast notification each time the fallback fires (default: true) */
  notify_on_fallback: z.boolean().optional(),
})

export type ContentFilterFallbackConfig = z.infer<typeof ContentFilterFallbackConfigSchema>
