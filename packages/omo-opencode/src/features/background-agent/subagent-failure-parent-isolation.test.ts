/// <reference types="bun-types" />

import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
}

let managerUnderTest: BackgroundManager | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  managerUnderTest = undefined
})

function createTask(overrides: Partial<BackgroundTask> & { id: string; parentSessionId: string }): BackgroundTask {
  const id = overrides.id
  const parentSessionID = overrides.parentSessionId
  const { id: _ignoredID, parentSessionId: _ignoredParentSessionID, ...rest } = overrides

  return {
    parentMessageId: overrides.parentMessageId ?? "parent-message-id",
    description: overrides.description ?? overrides.id,
    prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
    agent: overrides.agent ?? "test-agent",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date("2026-05-26T00:00:00.000Z"),
    ...rest,
    id,
    parentSessionId: parentSessionID,
  }
}

function createManager(): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => [
        {
          info: { role: "assistant", finish: "stop", time: { created: 1_000 } },
          parts: [{ type: "text", text: "done" }],
        },
      ],
      status: async () => ({ data: { "main-session": { type: "idle" }, "subagent-session": { type: "idle" } } }),
      get: async (input: { path: { id: string } }) => ({ data: input.path.id === "subagent-session" ? null : { id: input.path.id } }),
      prompt: async () => ({}),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return {}
      },
      abort: async () => ({}),
    },
  }
  const ctx: PluginInput = {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  return {
    manager: new BackgroundManager({ pluginContext: ctx, config: undefined, enableParentSessionNotifications: true }),
    promptAsyncCalls,
  }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

async function notifyParentSessionForTest(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (task: BackgroundTask) => Promise<void>
  return notifyParentSession.call(manager, task)
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve()
  }
}

describe("BackgroundManager nested completion error propagation", () => {
  test("a terminal error after a nested completion follows the ordinary subagent failure path", async () => {
    // given
    const { manager, promptAsyncCalls } = createManager()
    managerUnderTest = manager
    const outerTask = createTask({
      id: "bg-main",
      parentSessionId: "main-session",
      sessionId: "subagent-session",
      description: "Draft fresh shipping plan",
      status: "running",
    })
    const nestedFailure = createTask({
      id: "bg-momus",
      parentSessionId: "subagent-session",
      description: "Momus re-review v2 (bg)",
      status: "error",
      error: "UnknownError: UnknownError",
      completedAt: new Date("2026-05-26T00:00:01.000Z"),
    })
    getTasks(manager).set(outerTask.id, outerTask)
    getPendingByParent(manager).set(nestedFailure.parentSessionId, new Set([nestedFailure.id]))
    await notifyParentSessionForTest(manager, nestedFailure)

    // when
    manager.handleEvent({
      type: "session.error",
      properties: {
        sessionID: "subagent-session",
        error: { name: "UnknownError", message: "UnknownError" },
      },
    })
    await flushMicrotasks()

    // then
    expect(promptAsyncCalls).toHaveLength(2)
    expect(promptAsyncCalls[0]?.path.id).toBe("subagent-session")
    expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
    expect(JSON.stringify(promptAsyncCalls[0]?.body.parts)).toContain("[ALL BACKGROUND TASKS FINISHED]")
    expect(outerTask.status).toBe("error")
    expect(promptAsyncCalls[1]?.path.id).toBe("main-session")
    expect(promptAsyncCalls[1]?.body.noReply).toBe(false)
  })
})
