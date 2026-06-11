import type { OpencodeClient } from "../../tools/delegate-task/types"
import { log } from "../../shared/logger"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../shared/prompt-async-gate"
import { getLastUserRetryPayload } from "../runtime-fallback/last-user-retry-parts"
import { resolveOriginalUserRetryMetadata } from "../runtime-fallback/auto-retry-metadata"
import { buildRetryModelPayload } from "../runtime-fallback/retry-model-payload"
import { createInternalAgentContinuationTextPart } from "../../shared/internal-initiator-marker"

const SOURCE = "content-filter-fallback"

export type ContentFilterRetryResult = "accepted" | "skipped" | "failed"

/**
 * Re-run the filtered turn exactly once on the configured fallback model.
 *
 * Reuses ONLY the pure helpers from runtime-fallback (last-user-parts +
 * original-user metadata + model-payload builder); it does NOT call
 * `autoRetryWithFallback`, which would mutate the error-driven state machine
 * (`sessionAwaitingFallbackResult`, fallback timeouts) and inherit the source
 * agent's variant/reasoning. The configured `fallbackModel` is authoritative.
 *
 * The model override lives in the prompt body, so the session's persistent
 * agent model is unchanged: the NEXT turn returns to the source model
 * (single-shot, not a permanent switch). No `session.abort` — the
 * content-filter finish is already terminal.
 */
export async function dispatchContentFilterFallbackRetry(args: {
  client: OpencodeClient
  directory: string
  sessionID: string
  fallbackModel: string
}): Promise<ContentFilterRetryResult> {
  const retryModelPayload = buildRetryModelPayload(args.fallbackModel)
  if (!retryModelPayload) {
    log(`[${SOURCE}] Invalid fallback_model (missing provider prefix)`, {
      sessionID: args.sessionID,
      fallbackModel: args.fallbackModel,
    })
    return "failed"
  }

  let messagesResp: unknown
  try {
    messagesResp = await args.client.session.messages({
      path: { id: args.sessionID },
      query: { directory: args.directory },
    })
  } catch (error) {
    log(`[${SOURCE}] Failed to fetch messages for retry`, {
      sessionID: args.sessionID,
      error: error instanceof Error ? error.message : String(error),
    })
    return "failed"
  }

  const retryPayload = getLastUserRetryPayload(messagesResp, args.sessionID)
  const originalRetryMetadata = resolveOriginalUserRetryMetadata(messagesResp)
  const fetchedParts =
    originalRetryMetadata.parts.length > 0 ? originalRetryMetadata.parts : retryPayload.retryParts
  const usingFetchedUserParts = originalRetryMetadata.parts.length > 0
  const retryParts =
    fetchedParts.length > 0
      ? fetchedParts
      : // No persisted user parts (e.g. messages not yet flushed). Fall back to
        // an internally-initiated continuation so the UI does not render a bare
        // "continue" user turn.
        [createInternalAgentContinuationTextPart("continue")]
  const retryMessageID = usingFetchedUserParts ? originalRetryMetadata.messageID : undefined

  try {
    const promptResult = await dispatchInternalPrompt({
      mode: "async",
      client: args.client,
      sessionID: args.sessionID,
      source: SOURCE,
      settleMs: 0,
      queueBehavior: "defer",
      input: {
        path: { id: args.sessionID },
        body: {
          ...retryModelPayload,
          ...(retryPayload.system ? { system: retryPayload.system } : {}),
          ...(retryPayload.tools ? { tools: retryPayload.tools } : {}),
          ...(retryMessageID ? { messageID: retryMessageID } : {}),
          parts: retryParts,
        },
        query: { directory: args.directory },
      },
    })
    if (isInternalPromptDispatchAccepted(promptResult)) {
      log(`[${SOURCE}] Re-prompted filtered turn on fallback model`, {
        sessionID: args.sessionID,
        fallbackModel: args.fallbackModel,
      })
      return "accepted"
    }
    log(`[${SOURCE}] Retry skipped by prompt gate`, {
      sessionID: args.sessionID,
      status: promptResult.status,
    })
    return "skipped"
  } catch (error) {
    log(`[${SOURCE}] Retry dispatch failed`, {
      sessionID: args.sessionID,
      error: error instanceof Error ? error.message : String(error),
    })
    return "failed"
  }
}
