import type { ToolContextWithMetadata, OpencodeClient } from "./types"
import type { SessionMessage } from "./executor-types"
import { getDefaultSyncPollTimeoutMs, getTimingConfig } from "./timing"
import { log } from "../../shared/logger"
import { normalizeSDKResponse } from "../../shared"
import { extractErrorMessage } from "../../features/background-agent/error-classifier"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../../shared/prompt-async-gate"
import { createInternalAgentContinuationTextPart } from "../../shared/internal-initiator-marker"

const NON_TERMINAL_FINISH_REASONS = new Set(["tool-calls", "unknown"])
const PENDING_TOOL_PART_TYPES = new Set(["tool", "tool_use", "tool-call"])
const ACTIVE_SESSION_STATUSES = new Set(["busy", "retry", "running"])
const CHILD_WAKE_GRACE_MS = 5_000
const STALLED_TURN_NUDGE_GRACE_MS = 90_000
const MAX_STALLED_TURN_NUDGES = 2
const MID_TURN_STALL_GRACE_MS = 180_000
const RUNNING_TOOL_STATUS = "running"
const STALLED_TURN_NUDGE_PROMPT =
  "Your previous response was interrupted before it finished (the stream ended without a stop reason). Continue from where you stopped and complete the task."

function wait(milliseconds: number): Promise<void> {
  const sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const typedArray = new Int32Array(sharedBuffer)
  const result = Atomics.waitAsync(typedArray, 0, 0, milliseconds)
  return result.async ? result.value.then(() => undefined) : Promise.resolve()
}

function abortSyncSession(client: OpencodeClient, sessionID: string, reason: string): void {
  log("[task] Aborting sync session", { sessionID, reason })
  void client.session.abort({
    path: { id: sessionID },
  }).catch((error: unknown) => {
    log("[task] Failed to abort sync session", { sessionID, reason, error: String(error) })
  })
}

function isActiveSessionStatus(status: { type: string } | undefined): boolean {
  return status !== undefined && ACTIVE_SESSION_STATUSES.has(status.type)
}

// Fingerprint of the in-progress assistant turn's latest content. It advances
// when the stream emits a new part, grows reasoning/text, or moves a tool's
// state forward. Returns undefined when there is no in-progress assistant part
// yet (time-to-first-token latency) or the latest turn is not assistant-led, so
// callers never treat pre-stream latency as a stall. The part-index fallback
// disambiguates two distinct empty parts that lack ids.
function computeMidTurnFingerprint(assistant: SessionMessage | undefined): string | undefined {
  if (!assistant || assistant.info?.role !== "assistant") return undefined
  const parts = assistant.parts ?? []
  if (parts.length === 0) return undefined
  const lastIndex = parts.length - 1
  const last = parts[lastIndex]
  const partKey = [
    last.id ?? `idx${lastIndex}`,
    last.type ?? "",
    (last.text ?? "").length,
    last.callID ?? "",
    last.state?.status ?? "",
  ].join("|")
  return `${assistant.info?.id ?? ""}#${parts.length}#${partKey}`
}

// A tool part that is actively executing may legitimately produce no stream
// bytes for a long time (local work), so the tool-level timeout must own that
// case rather than the mid-turn stall detector. A merely "pending" tool (never
// entered execution) is NOT protected - that is the T11 failure mode.
function hasRunningToolPart(assistant: SessionMessage | undefined): boolean {
  const parts = assistant?.parts ?? []
  return parts.some(
    (part) =>
      part.type !== undefined
      && PENDING_TOOL_PART_TYPES.has(part.type)
      && part.state?.status === RUNNING_TOOL_STATUS,
  )
}

async function fetchSessionMessages(
  client: OpencodeClient,
  sessionID: string
): Promise<SessionMessage[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionID } })
  const rawData = (messagesResult as { data?: unknown })?.data ?? messagesResult
  return Array.isArray(rawData) ? (rawData as SessionMessage[]) : []
}

function getTerminalSessionError(messages: SessionMessage[]): string | null {
  const lastAssistant = [...messages].reverse().find((msg) => msg.info?.role === "assistant")
  const lastUser = [...messages].reverse().find((msg) => msg.info?.role === "user")
  if (lastUser?.info?.id && lastAssistant?.info?.id && lastAssistant.info.id <= lastUser.info.id) {
    return null
  }
  if (!lastAssistant?.info || !("error" in lastAssistant.info)) {
    return null
  }

  const errorMessage = extractErrorMessage((lastAssistant.info as { error?: unknown }).error)
  return errorMessage && errorMessage.length > 0 ? errorMessage : "Session error"
}

export function isSessionComplete(messages: SessionMessage[]): boolean {
  let lastUser: SessionMessage | undefined
  let lastAssistant: SessionMessage | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!lastAssistant && msg.info?.role === "assistant") lastAssistant = msg
    if (!lastUser && msg.info?.role === "user") lastUser = msg
    if (lastUser && lastAssistant) break
  }

  if (!lastAssistant?.info?.finish) return false
  if (NON_TERMINAL_FINISH_REASONS.has(lastAssistant.info.finish)) return false
  if (lastAssistant.parts?.some((part) => part.type && PENDING_TOOL_PART_TYPES.has(part.type))) return false
  if (!lastUser?.info?.id || !lastAssistant?.info?.id) return false
  return lastUser.info.id < lastAssistant.info.id
}

const DEFAULT_MAX_ASSISTANT_TURNS = 300

async function dispatchStalledTurnNudgePrompt(client: OpencodeClient, sessionID: string): Promise<boolean> {
  const result = await dispatchInternalPrompt({
    mode: "async",
    client,
    sessionID,
    source: "task-stalled-turn-nudge",
    settleMs: 0,
    queueBehavior: "defer",
    // The poll loop has already verified the session is not busy, and the
    // stalled turn (finish: "unknown") would trip the gate's own tool-state
    // inspection when the interrupted turn produced no substantive output -
    // exactly the case that most needs the nudge.
    checkStatus: false,
    checkToolState: false,
    input: {
      path: { id: sessionID },
      body: {
        parts: [createInternalAgentContinuationTextPart(STALLED_TURN_NUDGE_PROMPT)],
      },
    },
  })
  if (!isInternalPromptDispatchAccepted(result)) {
    log("[task] Stalled-turn nudge not accepted by prompt gate", { sessionID, status: result.status })
    return false
  }
  return true
}

export async function pollSyncSession(
  ctx: ToolContextWithMetadata,
  client: OpencodeClient,
  input: {
    sessionID: string
    agentToUse: string
    toastManager: { removeTask: (id: string) => void } | null | undefined
    taskId: string | undefined
    anchorMessageCount?: number
    maxAssistantTurns?: number
    hasActiveChildBackgroundTasks?: (sessionID: string) => boolean
    childWakeGraceMs?: number
    stalledTurnNudgeGraceMs?: number
    dispatchStalledTurnNudge?: (sessionID: string) => Promise<boolean>
    midTurnStallGraceMs?: number
  },
  timeoutMs?: number
): Promise<string | null> {
  const syncTiming = getTimingConfig()
  const maxPollTimeMs = Math.max(timeoutMs ?? getDefaultSyncPollTimeoutMs(), 50)
  const maxTurns = input.maxAssistantTurns ?? DEFAULT_MAX_ASSISTANT_TURNS
  const pollStart = Date.now()
  let inactiveStart = pollStart
  let pollCount = 0
  let timedOut = false
  let assistantTurnCount = 0
  let lastSeenAssistantId: string | undefined
  const childWakeGraceMs = input.childWakeGraceMs ?? CHILD_WAKE_GRACE_MS
  let childWaitAssistantId: string | undefined
  let childWaitStartedAt = 0
  const stalledTurnNudgeGraceMs = input.stalledTurnNudgeGraceMs ?? STALLED_TURN_NUDGE_GRACE_MS
  const dispatchStalledTurnNudge = input.dispatchStalledTurnNudge
    ?? ((sessionID: string) => dispatchStalledTurnNudgePrompt(client, sessionID))
  let stalledAssistantId: string | undefined
  let stalledSince = 0
  let stalledNudgeCount = 0
  const midTurnStallGraceMs = input.midTurnStallGraceMs ?? MID_TURN_STALL_GRACE_MS
  let midTurnFingerprint: string | undefined
  let midTurnAssistantId: string | undefined
  let midTurnFrozenSince = 0
  const shouldWaitForChildTasks = (currentAssistantId: string | undefined): boolean => {
    if (input.hasActiveChildBackgroundTasks?.(input.sessionID)) {
      childWaitAssistantId = currentAssistantId
      childWaitStartedAt = 0
    } else if (childWaitAssistantId === undefined || currentAssistantId !== childWaitAssistantId) {
      return false
    } else {
      childWaitStartedAt ||= Date.now()
    }
    return childWaitStartedAt === 0 || Date.now() - childWaitStartedAt < childWakeGraceMs
  }

  log("[task] Starting poll loop", { sessionID: input.sessionID, agentToUse: input.agentToUse, maxTurns })

  while (true) {
    const inactiveElapsedMs = Date.now() - inactiveStart
    if (inactiveElapsedMs >= maxPollTimeMs) {
      timedOut = true
      break
    }

    if (ctx.abort?.aborted) {
      let finalMessages: SessionMessage[] | null = null
      const abortFetchAttempts = 3
      for (let attempt = 1; attempt <= abortFetchAttempts; attempt++) {
        try {
          finalMessages = await fetchSessionMessages(client, input.sessionID)
          break
        } catch (error) {
          log("[task] Final messages fetch failed after abort, retrying", {
            sessionID: input.sessionID,
            attempt,
            maxAttempts: abortFetchAttempts,
            error: String(error),
          })
          if (attempt < abortFetchAttempts) {
            await wait(syncTiming.POLL_INTERVAL_MS)
          }
        }
      }

      if (finalMessages) {
        const hasNewMessages =
          input.anchorMessageCount === undefined || finalMessages.length > input.anchorMessageCount
        if (hasNewMessages && isSessionComplete(finalMessages)) {
          log("[task] Abort detected after session already completed", { sessionID: input.sessionID })
          return null
        }
      }

      log("[task] Aborted by user", { sessionID: input.sessionID })
      abortSyncSession(client, input.sessionID, "parent_abort")
      if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
      return `Task aborted.\n\nSession ID: ${input.sessionID}`
    }

    await wait(syncTiming.POLL_INTERVAL_MS)
    pollCount++

    let sessionStatus: { type: string } | undefined
    try {
      const statusResult = await client.session.status()
      const allStatuses = normalizeSDKResponse(statusResult, {} as Record<string, { type: string }>)
      sessionStatus = allStatuses[input.sessionID]
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log("[task] Poll status fetch failed, checking messages", { sessionID: input.sessionID, error: errorMessage })
    }

    if (pollCount % 10 === 0) {
      log("[task] Poll status", {
        sessionID: input.sessionID,
        pollCount,
        elapsed: Math.floor((Date.now() - pollStart) / 1000) + "s",
        inactiveElapsed: Math.floor(inactiveElapsedMs / 1000) + "s",
        sessionStatus: sessionStatus?.type ?? "not_in_status",
      })
    }

    if (isActiveSessionStatus(sessionStatus)) {
      const nowMs = Date.now()
      inactiveStart = nowMs
      // Mid-turn stall: a provider stream can open a reasoning/text part (or
      // announce a pending tool) then go silent without closing the stream or
      // emitting an error. The session stays "busy" indefinitely, so the
      // inactivity timeout above never fires (it resets every active poll).
      // Fingerprint the in-progress turn; if it does not advance within the
      // grace window and no tool is actively running, abort and surface a
      // retryable result to the parent instead of hanging.
      let midTurnMessages: SessionMessage[] | undefined
      try {
        midTurnMessages = await fetchSessionMessages(client, input.sessionID)
      } catch (error) {
        log("[task] Mid-turn stall fetch failed, skipping this poll", { sessionID: input.sessionID, error: String(error) })
      }
      if (midTurnMessages) {
        const midTurnAssistant = [...midTurnMessages].reverse().find((m) => m.info?.role === "assistant")
        const fingerprint = computeMidTurnFingerprint(midTurnAssistant)
        if (fingerprint === undefined) {
          midTurnFingerprint = undefined
          midTurnAssistantId = undefined
          midTurnFrozenSince = 0
        } else if (
          midTurnAssistant?.info?.id !== midTurnAssistantId
          || fingerprint !== midTurnFingerprint
        ) {
          midTurnAssistantId = midTurnAssistant?.info?.id
          midTurnFingerprint = fingerprint
          midTurnFrozenSince = nowMs
        } else if (nowMs - midTurnFrozenSince >= midTurnStallGraceMs) {
          if (hasRunningToolPart(midTurnAssistant)) {
            // Legit long-running tool; let the tool-level timeout own this.
            midTurnFrozenSince = nowMs
          } else {
            const frozenMs = nowMs - midTurnFrozenSince
            log("[task] Mid-turn stall detected (busy with no stream or tool progress), aborting", {
              sessionID: input.sessionID,
              assistantID: midTurnAssistant?.info?.id,
              fingerprint,
              frozenMs,
            })
            abortSyncSession(client, input.sessionID, "mid_turn_stall")
            if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
            return `Task aborted: subagent stalled mid-turn for ${midTurnStallGraceMs}ms with no stream or tool progress. This is retryable. Session ID: ${input.sessionID}`
          }
        }
      }
      continue
    }

    // Session is not active this poll; clear mid-turn freeze tracking so a later
    // busy turn is evaluated fresh and never inherits a stale freeze timer.
    midTurnFingerprint = undefined
    midTurnAssistantId = undefined
    midTurnFrozenSince = 0

    let messages: SessionMessage[]
    try {
      messages = await fetchSessionMessages(client, input.sessionID)
    } catch (error) {
      log("[task] Poll messages fetch failed, retrying", { sessionID: input.sessionID, error: String(error) })
      continue
    }

    if (input.anchorMessageCount !== undefined && messages.length <= input.anchorMessageCount) {
      continue
    }

    const sessionError = getTerminalSessionError(messages)
    if (sessionError) {
      log("[task] Poll detected terminal session error", { sessionID: input.sessionID, sessionError })
      return sessionError
    }

    if (isSessionComplete(messages)) {
      const currentAssistantId = [...messages].reverse().find((m) => m.info?.role === "assistant")?.info?.id
      if (shouldWaitForChildTasks(currentAssistantId)) {
        continue
      }
      log("[task] Poll complete - terminal finish detected", { sessionID: input.sessionID, pollCount })
      break
    }

    // Count new assistant turns to circuit-break infinite loops
    const lastAssistant = [...messages].reverse().find((m) => m.info?.role === "assistant")
    if (lastAssistant?.info?.id && lastAssistant.info.id !== lastSeenAssistantId) {
      lastSeenAssistantId = lastAssistant.info.id
      assistantTurnCount++
      if (assistantTurnCount >= maxTurns) {
        log("[task] Max assistant turns reached, aborting to prevent infinite loop", {
          sessionID: input.sessionID,
          assistantTurnCount,
          maxTurns,
        })
        abortSyncSession(client, input.sessionID, "max_turns_exceeded")
        if (input.toastManager && input.taskId) input.toastManager.removeTask(input.taskId)
        return `Task aborted: subagent exceeded ${maxTurns} assistant turns without completing. This usually indicates an infinite tool-call loop. Session ID: ${input.sessionID}`
      }
    }

    // Silent stream death: the session is idle but the latest assistant turn
    // ended with finish "unknown" (provider stream died without a stop reason
    // and without an error event). isSessionComplete will never accept it and
    // no error-driven recovery fires, so without intervention the poll would
    // wait out the full inactivity timeout. Nudge the session to continue.
    const lastUserForStall = [...messages].reverse().find((m) => m.info?.role === "user")
    const isStalledUnknownTurn =
      lastAssistant?.info?.id !== undefined
      && lastAssistant.info.finish === "unknown"
      && lastUserForStall?.info?.id !== undefined
      && lastUserForStall.info.id < lastAssistant.info.id
    if (isStalledUnknownTurn && lastAssistant?.info?.id) {
      if (stalledAssistantId !== lastAssistant.info.id) {
        stalledAssistantId = lastAssistant.info.id
        stalledSince = Date.now()
      } else if (
        Date.now() - stalledSince >= stalledTurnNudgeGraceMs
        && stalledNudgeCount < MAX_STALLED_TURN_NUDGES
      ) {
        stalledNudgeCount++
        log("[task] Stalled turn detected (finish: unknown while idle), dispatching continuation nudge", {
          sessionID: input.sessionID,
          assistantID: lastAssistant.info.id,
          nudge: stalledNudgeCount,
          maxNudges: MAX_STALLED_TURN_NUDGES,
        })
        try {
          if (await dispatchStalledTurnNudge(input.sessionID)) {
            inactiveStart = Date.now()
          }
        } catch (error) {
          log("[task] Stalled-turn nudge dispatch failed", {
            sessionID: input.sessionID,
            error: String(error),
          })
        }
        stalledSince = Date.now()
      }
    } else {
      stalledAssistantId = undefined
    }

    const hasAssistantText = messages.some((m) => {
      if (m.info?.role !== "assistant") return false
      const parts = m.parts ?? []
      return parts.some((p) => {
        if (p.type !== "text" && p.type !== "reasoning") return false
        const text = (p.text ?? "").trim()
        return text.length > 0
      })
    })

    if (!lastAssistant?.info?.finish && hasAssistantText) {
      if (shouldWaitForChildTasks(lastAssistant?.info?.id)) {
        continue
      }
      log("[task] Poll complete - assistant text detected (fallback)", {
        sessionID: input.sessionID,
        pollCount,
      })
      break
    }
  }

  if (timedOut) {
    log("[task] Poll inactivity timeout reached", { sessionID: input.sessionID, pollCount })
    abortSyncSession(client, input.sessionID, "poll_timeout")
  }

  return timedOut
    ? `Poll inactivity timeout reached after ${maxPollTimeMs}ms without active OpenCode status for session ${input.sessionID}`
    : null
}
