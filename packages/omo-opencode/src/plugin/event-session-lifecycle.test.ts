import { afterEach, describe, expect, mock, test } from "bun:test"

import { _resetForTesting, subagentSessions, syncSubagentSessions } from "../features/claude-code-session-state"
import { handleSessionDeletedEvent } from "./event-session-lifecycle"

function createDeletedEventArgs(sessionID: string): Parameters<typeof handleSessionDeletedEvent>[0] {
  return {
    props: { info: { id: sessionID } },
    tmuxIntegrationEnabled: false,
    pluginConfig: {},
    pluginContext: { directory: "/tmp" },
    managers: {
      skillMcpManager: { disconnectSession: mock(async () => {}) },
      tmuxSessionManager: {
        getTrackedPaneId: () => undefined,
        onSessionDeleted: mock(async () => {}),
      },
    },
    firstMessageVariantGate: { clear: mock(() => {}) },
    clearModelFallbackSession: mock(() => {}),
  } as never
}

afterEach(() => {
  _resetForTesting()
})

describe("handleSessionDeletedEvent", () => {
  test("#given a non-sync subagent session is deleted #when lifecycle cleanup runs #then stale subagent classification is cleared", async () => {
    // given
    subagentSessions.add("subagent-session")
    expect(syncSubagentSessions.has("subagent-session")).toBe(false)

    // when
    await handleSessionDeletedEvent(createDeletedEventArgs("subagent-session"))

    // then
    expect(subagentSessions.has("subagent-session")).toBe(false)
    expect(syncSubagentSessions.has("subagent-session")).toBe(false)
  })
})
