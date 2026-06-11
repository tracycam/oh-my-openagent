import type { HookDeps, RuntimeFallbackTimeout } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME, DEFAULT_FIRST_PROMPT_WATCHDOG_MS } from "./constants"
import { log } from "../../shared/logger"
import { subagentSessions } from "../../features/claude-code-session-state"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
import { isRecord } from "../../shared/record-type-guard"
import { normalizeModelToCanonicalString } from "./normalize-model"
import { createFallbackState } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"

const SOURCE = "first-prompt-watchdog"
const SESSION_NEXT_EVENT_PREFIX = "session.next."
const MAX_SAME_MODEL_WATCHDOG_RETRIES = 2

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

export interface FirstPromptWatchdog {
  onUserMessage(sessionID: string, model?: string, agent?: string): void
  onAssistantProgress(sessionID: string): void
  onSessionTerminal(sessionID: string): void
  dispose(): void
}

const TERMINAL_EVENT_TYPES = new Set([
  "session.idle",
  "session.stop",
  "session.deleted",
  "session.error",
])

function isCompletionMarker(value: unknown): boolean {
  if (typeof value === "boolean") return value
  return value !== undefined && value !== null
}

function hasAssistantCompletionMarker(info: Record<string, unknown>): boolean {
  const time = isRecord(info.time) ? info.time : undefined
  return isCompletionMarker(info.finish)
    || isCompletionMarker(info.finished)
    || isCompletionMarker(info.completed)
    || isCompletionMarker(time?.completed)
}

/**
 * Part types that are purely structural turn scaffolding, NOT model output.
 * An assistant message emits these (and may open an *empty* reasoning/text
 * part) before the provider has produced a single token. Treating them as
 * "progress" disarms the watchdog while the stream is still silent — exactly
 * how a stalled reasoning block (empty `reasoning` part + `step-start`, then
 * zero tokens for 30 min) escaped recovery and hung indefinitely.
 */
const STRUCTURAL_PART_TYPES = new Set(["step-start", "step-finish"])
const TEXTUAL_PART_TYPES = new Set(["text", "reasoning"])

function partHasContent(part: Record<string, unknown>): boolean {
  return typeof part.text === "string" && part.text.trim().length > 0
}

/**
 * True only when a part represents *real* model output:
 *   - tool / tool_use / tool-call / tool_result / file / ...: the model is
 *     actively doing concrete work, so it is not silent.
 *   - text / reasoning: ONLY when they carry non-empty content. A freshly
 *     opened reasoning/text block with no text yet is NOT progress.
 * Structural markers (step-start/step-finish) never count.
 */
function isRealProgressPart(part: unknown): boolean {
  if (!isRecord(part)) return false
  const type = typeof part.type === "string" ? part.type : undefined
  if (!type) return false
  if (STRUCTURAL_PART_TYPES.has(type)) return false
  if (TEXTUAL_PART_TYPES.has(type)) return partHasContent(part)
  return true
}

/**
 * Translate an OpenCode session event into the appropriate watchdog signal.
 *
 * Progress semantics for cancelling the watchdog (see isRealProgressPart):
 *   - assistant `info.error` set: the message-update-handler owns the error
 *     path; the watchdog has done its job.
 *   - assistant `info.finish` set: the response completed.
 *   - a real-content part (tool/file activity, or non-empty text/reasoning)
 *     or a non-empty text delta: the model is genuinely producing output.
 *   - structural-only parts (step-start) and EMPTY text/reasoning parts do
 *     NOT count — the stream may still be silently stalled.
 */
export function observeEventForWatchdog(
  event: { type: string; properties?: unknown },
  watchdog: FirstPromptWatchdog,
): void {
  const props = isRecord(event.properties) ? event.properties : undefined
  if (!props) return

  if (event.type.startsWith(SESSION_NEXT_EVENT_PREFIX)) {
    const sessionID = resolveSessionEventID(props) ?? resolveMessageEventSessionID(props)
    if (sessionID) watchdog.onAssistantProgress(sessionID)
    return
  }

  if (event.type === "message.part.updated" || event.type === "message.part.delta") {
    const sessionID = resolveMessageEventSessionID(props)
    if (!sessionID) return
    const part = isRecord(props.part) ? props.part : undefined
    const hasTextDelta =
      props.field === "text" && typeof props.delta === "string" && props.delta.trim().length > 0
    if (hasTextDelta || isRealProgressPart(part)) {
      watchdog.onAssistantProgress(sessionID)
    }
    return
  }

  if (event.type === "message.updated") {
    const info = isRecord(props.info) ? props.info : undefined
    if (!info) return
    const sessionID = typeof info?.sessionID === "string" ? info.sessionID : undefined
    const role = typeof info?.role === "string" ? info.role : undefined
    if (!sessionID || !role) return

    if (role === "user") {
      const model = normalizeModelToCanonicalString(info?.model)
      const agent = typeof info?.agent === "string" ? info.agent : undefined
      watchdog.onUserMessage(sessionID, model, agent)
      return
    }

    if (role === "assistant") {
      const hasError = info?.error !== undefined
      const hasFinish = hasAssistantCompletionMarker(info)
      const eventParts = Array.isArray(props.parts) ? props.parts : undefined
      const infoParts = Array.isArray(info?.parts) ? info.parts : undefined
      const parts = eventParts ?? infoParts ?? []
      const hasRealProgress = parts.some((part) => isRealProgressPart(part))
      if (hasError || hasFinish || hasRealProgress) {
        watchdog.onAssistantProgress(sessionID)
      }
    }
    return
  }

  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    const sessionID = resolveSessionEventID(props)
    if (sessionID) watchdog.onSessionTerminal(sessionID)
  }
}

export function createFirstPromptWatchdog(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  watchdogMs: number = DEFAULT_FIRST_PROMPT_WATCHDOG_MS,
): FirstPromptWatchdog {
  const timers = new Map<string, RuntimeFallbackTimeout>()
  const armed = new Set<string>()
  const sameModelRetryAttempts = new Map<string, number>()

  const cancel = (sessionID: string): void => {
    const timer = timers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      timers.delete(sessionID)
    }
    armed.delete(sessionID)
  }

  const fire = async (sessionID: string, model: string | undefined, agent: string | undefined): Promise<void> => {
    timers.delete(sessionID)
    armed.delete(sessionID)

    if (!subagentSessions.has(sessionID)) {
      log(`[${HOOK_NAME}] ${SOURCE}: session no longer a subagent at fire time, skipping`, { sessionID })
      return
    }

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, deps.pluginConfig)

    if (fallbackModels.length === 0) {
      // No fallback model configured (e.g. plan agent on a fixed model). A
      // silently-dying stream (finish: "unknown", no error event) would
      // otherwise go completely unrecovered until the caller's poll timeout.
      // Degrade to a same-model abort + re-prompt, capped per session.
      const attempts = sameModelRetryAttempts.get(sessionID) ?? 0
      if (attempts >= MAX_SAME_MODEL_WATCHDOG_RETRIES) {
        log(`[${HOOK_NAME}] ${SOURCE}: subagent silent past ${watchdogMs}ms, same-model retries exhausted`, {
          sessionID,
          model,
          agent: resolvedAgent,
          attempts,
        })
        return
      }

      const retryModel = model ?? resolveFallbackBootstrapModel({
        sessionID,
        source: SOURCE,
        eventModel: model,
        resolvedAgent,
        pluginConfig: deps.pluginConfig,
      })
      if (!retryModel) {
        log(`[${HOOK_NAME}] ${SOURCE}: subagent silent past ${watchdogMs}ms with no fallback configured and no model info for same-model retry`, {
          sessionID,
          agent: resolvedAgent,
        })
        return
      }

      sameModelRetryAttempts.set(sessionID, attempts + 1)
      log(`[${HOOK_NAME}] ${SOURCE}: subagent silent past ${watchdogMs}ms with no fallback configured, retrying same model`, {
        sessionID,
        model: retryModel,
        agent: resolvedAgent,
        attempt: attempts + 1,
        maxAttempts: MAX_SAME_MODEL_WATCHDOG_RETRIES,
      })

      await helpers.abortSessionRequest(sessionID, SOURCE)
      await helpers.autoRetryWithFallback(sessionID, retryModel, resolvedAgent, SOURCE)
      return
    }

    let state = deps.sessionStates.get(sessionID)
    if (!state) {
      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: SOURCE,
        eventModel: model,
        resolvedAgent,
        pluginConfig: deps.pluginConfig,
      })
      if (!initialModel) {
        log(`[${HOOK_NAME}] ${SOURCE}: no model info available, cannot dispatch fallback`, { sessionID })
        return
      }
      state = createFallbackState(initialModel)
      deps.sessionStates.set(sessionID, state)
      deps.sessionLastAccess.set(sessionID, Date.now())
    }

    log(`[${HOOK_NAME}] ${SOURCE}: subagent silent past ${watchdogMs}ms, dispatching fallback`, {
      sessionID,
      model: state.currentModel,
      fallbackCount: fallbackModels.length,
    })

    // Unlike the error-event path, the original request is still pending from
    // OpenCode's perspective when the watchdog fires. Forcefully end it so the
    // fallback prompt can take over cleanly. Network errors from abort are
    // logged inside abortSessionRequest and do not block fallback dispatch.
    await helpers.abortSessionRequest(sessionID, SOURCE)

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels,
      resolvedAgent,
      source: SOURCE,
    })
  }

  return {
    onUserMessage(sessionID, model, agent) {
      if (!sessionID) return
      if (!subagentSessions.has(sessionID)) return
      if (armed.has(sessionID)) return

      armed.add(sessionID)
      const timer = setTimeout(async () => {
        await fire(sessionID, model, agent)
      }, watchdogMs)
      timers.set(sessionID, timer)

      log(`[${HOOK_NAME}] ${SOURCE}: armed for subagent`, { sessionID, model, agent, watchdogMs })
    },
    onAssistantProgress(sessionID) {
      if (!sessionID || !armed.has(sessionID)) return
      cancel(sessionID)
      sameModelRetryAttempts.delete(sessionID)
      log(`[${HOOK_NAME}] ${SOURCE}: cancelled (assistant progress observed)`, { sessionID })
    },
    onSessionTerminal(sessionID) {
      if (!sessionID || !armed.has(sessionID)) return
      cancel(sessionID)
      log(`[${HOOK_NAME}] ${SOURCE}: cancelled (session terminal)`, { sessionID })
    },
    dispose() {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      armed.clear()
      sameModelRetryAttempts.clear()
    },
  }
}
