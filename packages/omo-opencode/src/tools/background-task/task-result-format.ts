import type { BackgroundTask } from "../../features/background-agent"
import { extractErrorMessage } from "../../features/background-agent/error-classifier"
import type { BackgroundOutputClient, BackgroundOutputMessage, BackgroundOutputMessagesResult } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { formatDuration } from "./time-format"
import { getBackgroundOutputFetchTimeoutMs, withSdkCallTimeout } from "./with-sdk-call-timeout"

function getTimeString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function formatHeader(task: BackgroundTask): string {
  const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)
  return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionId}

---

`
}

type AssistantPart = NonNullable<BackgroundOutputMessage["parts"]>[number]

function extractTextFromParts(parts: AssistantPart[] | undefined): string {
  if (!parts || parts.length === 0) return ""
  const pieces: string[] = []
  for (const part of parts) {
    // Only the assistant's actual answer text. Reasoning (CoT / `<analysis>`
    // blocks) is the subagent's internal thinking and must not be surfaced
    // to the orchestrator as part of the "result".
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      pieces.push(part.text)
    }
  }
  return pieces.join("\n\n")
}

function extractToolResultText(part: AssistantPart): string {
  const content = (part as { content?: string | Array<{ type: string; text?: string }> }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const pieces: string[] = []
    for (const block of content) {
      if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string" && block.text.length > 0) {
        pieces.push(block.text)
      }
    }
    return pieces.join("\n\n")
  }
  return ""
}

function findLastToolResultText(messages: BackgroundOutputMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].type === "tool_result") {
        const text = extractToolResultText(parts[j])
        if (text.length > 0) return text
      }
    }
  }
  return ""
}

export async function formatTaskResult(task: BackgroundTask, client: BackgroundOutputClient): Promise<string> {
  if (!task.sessionId) {
    return `Error: Task has no sessionID`
  }

  let messagesResult: BackgroundOutputMessagesResult
  try {
    messagesResult = await withSdkCallTimeout(
      client.session.messages({ path: { id: task.sessionId } }),
      getBackgroundOutputFetchTimeoutMs(),
    )
  } catch (error) {
    return `Error fetching messages: ${error instanceof Error ? error.message : String(error)}`
  }

  const errorMessage = getErrorMessage(messagesResult)
  if (errorMessage) {
    return `Error fetching messages: ${errorMessage}`
  }

  const messages = extractMessages(messagesResult)
  if (!Array.isArray(messages) || messages.length === 0) {
    return `${formatHeader(task)}(No messages found)`
  }

  const relevantMessages = messages.filter((m) => m.info?.role === "assistant" || m.info?.role === "tool")
  if (relevantMessages.length === 0) {
    return `${formatHeader(task)}(No assistant or tool response found)`
  }

  const sortedMessages = [...relevantMessages].sort((a, b) => {
    const timeA = getTimeString(a.info?.time)
    const timeB = getTimeString(b.info?.time)
    return timeA.localeCompare(timeB)
  })

  // Surface any session error from assistant messages with priority over success text.
  const sessionError = sortedMessages
    .filter((message) => message.info?.role === "assistant" && message.info?.error)
    .map((message) => extractErrorMessage(message.info?.error))
    .find((message): message is string => typeof message === "string" && message.length > 0)
  if (sessionError) {
    return `${formatHeader(task)}Session error: ${sessionError}`
  }

  // Distillation: a task "result" is the subagent's final answer to the
  // orchestrator — i.e. text parts of the last non-error assistant message.
  // Reasoning parts and intermediate tool_result parts are working memory
  // that lives in the subagent's session and must not pollute the result.
  // Orchestrator can request the full transcript via full_session=true.
  const assistantMessages = sortedMessages.filter((m) => m.info?.role === "assistant" && !m.info?.error)
  const lastAssistant = assistantMessages[assistantMessages.length - 1]

  let body = lastAssistant ? extractTextFromParts(lastAssistant.parts) : ""

  // Fallback A: last assistant produced no text (e.g. ended on a tool call).
  // Surface the most recent tool_result content so the orchestrator still
  // gets something actionable instead of an empty result.
  if (!body) {
    body = findLastToolResultText(sortedMessages)
  }

  if (!body) {
    body = "(Task completed without text output)"
  }

  return `${formatHeader(task)}${body}`
}
