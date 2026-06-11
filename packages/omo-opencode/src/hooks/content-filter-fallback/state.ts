/**
 * Per-session state for the content-filter fallback hook.
 *
 * Deliberately ISOLATED from runtime-fallback's state machine
 * (`sessionAwaitingFallbackResult`, `sessionRetryInFlight`, `sessionStates`).
 * Sharing those sets would corrupt the error-driven fallback flow. This hook
 * owns only:
 *   - `inFlight`: guards against concurrent re-prompts for the same session.
 *   - `handledMessageIds`: de-dupes the multiple `message.updated` emissions
 *     that fire for a single terminal assistant message, so one content-filter
 *     turn produces exactly one retry.
 *
 * There is intentionally NO cross-turn counter / circuit breaker: "single-shot"
 * means one retry per content-filter occurrence, not once-per-session.
 */
export type ContentFilterFallbackState = {
  readonly inFlight: Set<string>
  readonly handledMessageIds: Map<string, Set<string>>
}

export function createContentFilterFallbackState(): ContentFilterFallbackState {
  return {
    inFlight: new Set<string>(),
    handledMessageIds: new Map<string, Set<string>>(),
  }
}

/**
 * Mark a content-filter assistant message as handled. Returns `true` when this
 * is the first time we've seen it (caller should proceed), `false` when it was
 * already handled (caller should skip — a duplicate `message.updated`).
 *
 * When `messageID` is missing we cannot de-dupe by id; we return `true` and let
 * the `inFlight` guard cover concurrency. This is rare (terminal assistant
 * messages carry an id) and re-prompting replaces the turn, so the stale
 * message stops emitting updates shortly after.
 */
export function markContentFilterHandled(
  state: ContentFilterFallbackState,
  sessionID: string,
  messageID: string | undefined,
): boolean {
  if (!messageID) {
    return true
  }
  let handled = state.handledMessageIds.get(sessionID)
  if (!handled) {
    handled = new Set<string>()
    state.handledMessageIds.set(sessionID, handled)
  }
  if (handled.has(messageID)) {
    return false
  }
  handled.add(messageID)
  return true
}

export function clearContentFilterSession(
  state: ContentFilterFallbackState,
  sessionID: string,
): void {
  state.inFlight.delete(sessionID)
  state.handledMessageIds.delete(sessionID)
}

export function clearAllContentFilterState(state: ContentFilterFallbackState): void {
  state.inFlight.clear()
  state.handledMessageIds.clear()
}
