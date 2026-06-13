import type { PluginInput } from "@opencode-ai/plugin"
import { isRecord, log } from "../../shared"
import { normalizeSDKResponse } from "../../shared"

function getMessageRole(message: unknown): unknown {
  if (!isRecord(message)) {
    return undefined
  }
  const info = message.info
  return isRecord(info) ? info.role : undefined
}

function messagesAfterAnchor(messages: readonly unknown[], anchorMessageCount: number | undefined): readonly unknown[] {
  return anchorMessageCount === undefined ? messages : messages.slice(anchorMessageCount)
}

function valueHasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function contentBlockHasText(block: unknown): boolean {
  if (!isRecord(block)) {
    return false
  }

  const type = block.type
  if ((type === "text" || type === "reasoning") && valueHasText(block.text)) {
    return true
  }
  return valueHasText(block.content)
}

function messagePartHasResponseContent(part: unknown): boolean {
  if (!isRecord(part)) {
    return false
  }

  const type = part.type
  if ((type === "text" || type === "reasoning") && valueHasText(part.text)) {
    return true
  }
  if (valueHasText(part.content)) {
    return true
  }
  if (Array.isArray(part.content)) {
    return part.content.some(contentBlockHasText)
  }
  return false
}

function getMessageParts(message: unknown): readonly unknown[] {
  if (!isRecord(message)) {
    return []
  }
  return Array.isArray(message.parts) ? message.parts : []
}

function hasAssistantOrToolResponse(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    const role = getMessageRole(message)
    return (role === "assistant" || role === "tool")
      && getMessageParts(message).some(messagePartHasResponseContent)
  })
}

export async function waitForCompletion(
  sessionID: string,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  ctx: PluginInput,
  anchorMessageCount?: number,
): Promise<void> {
  log(`[call_omo_agent] Polling for completion...`)

  const POLL_INTERVAL_MS = 500
  const MAX_POLL_TIME_MS = 5 * 60 * 1000 // 5 minutes max
  const PROMPT_ACCEPTANCE_TIMEOUT_MS = 30 * 1000
  const pollStart = Date.now()
  let lastMsgCount = 0
  let stablePolls = 0
  const STABILITY_REQUIRED = 3
  let sawActiveStatus = false

  while (Date.now() - pollStart < MAX_POLL_TIME_MS) {
    if (toolContext.abort?.aborted) {
      log(`[call_omo_agent] Aborted by user`)
      throw new Error("Task aborted.")
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

    const statusResult = await ctx.client.session.status()
    const allStatuses = normalizeSDKResponse(statusResult, {} as Record<string, { type: string }>)
    const sessionStatus = allStatuses[sessionID]

    if (sessionStatus && sessionStatus.type !== "idle") {
      sawActiveStatus = true
      stablePolls = 0
      lastMsgCount = 0
      continue
    }

    const messagesCheck = await ctx.client.session.messages({ path: { id: sessionID } })
    const msgs = normalizeSDKResponse(messagesCheck, [] as Array<unknown>, {
      preferResponseOnMissingData: true,
    })
    const currentMsgCount = msgs.length
    const newMessages = messagesAfterAnchor(msgs, anchorMessageCount)

    if (newMessages.length === 0) {
      stablePolls = 0
      lastMsgCount = 0
      if (!sawActiveStatus && Date.now() - pollStart >= PROMPT_ACCEPTANCE_TIMEOUT_MS) {
        throw new Error(`Prompt was not durably accepted by OpenCode for session ${sessionID}.`)
      }
      continue
    }

    if (!hasAssistantOrToolResponse(newMessages)) {
      stablePolls = 0
      lastMsgCount = currentMsgCount
      continue
    }

    if (currentMsgCount === lastMsgCount) {
      stablePolls++
      if (stablePolls >= STABILITY_REQUIRED) {
        log(`[call_omo_agent] Session complete, ${currentMsgCount} messages`)
        break
      }
    } else {
      stablePolls = 0
      lastMsgCount = currentMsgCount
    }
  }

  if (Date.now() - pollStart >= MAX_POLL_TIME_MS) {
    log(`[call_omo_agent] Timeout reached`)
    throw new Error("Agent task timed out after 5 minutes.")
  }
}
