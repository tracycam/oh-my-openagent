import { isRecord } from "../../shared"
import { isEmptyNoProgressAssistantTurnInfo } from "./empty-assistant-turn"

function getTokenCount(tokens: unknown, key: "output" | "reasoning"): number | undefined {
  if (!isRecord(tokens)) {
    return undefined
  }
  const value = tokens[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function assistantInfoHasOutputSignal(info: Record<string, unknown>): boolean {
  const tokens = info.tokens
  const outputTokens = getTokenCount(tokens, "output")
  const reasoningTokens = getTokenCount(tokens, "reasoning")
  return (outputTokens !== undefined && outputTokens > 0)
    || (reasoningTokens !== undefined && reasoningTokens > 0)
}

export function messageUpdatedInfoHasParentWakeOutput(info: Record<string, unknown>, role: unknown): boolean {
  if (role === "tool") {
    return true
  }
  if (role !== "assistant") {
    return false
  }
  if (info.error) {
    return false
  }
  if (isEmptyNoProgressAssistantTurnInfo(info)) {
    return false
  }
  return assistantInfoHasOutputSignal(info)
}
