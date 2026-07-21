import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type PromptAsyncCall = {
  path: { id: string }
  body: { noReply?: boolean; parts?: Array<{ text?: string }> }
  query?: { directory?: string }
}

let managerUnderTest: BackgroundManager | undefined

afterEach(async () => {
  await managerUnderTest?.shutdown()
  managerUnderTest = undefined
})

function createTask(input: {
  id: string
  parentSessionId?: string
  status: BackgroundTask["status"]
  error?: string
}): BackgroundTask {
  return {
    id: input.id,
    parentSessionId: input.parentSessionId ?? "parent-1",
    parentMessageId: "parent-message",
    description: `description for ${input.id}`,
    prompt: `prompt for ${input.id}`,
    agent: "explore",
    status: input.status,
    error: input.error,
    startedAt: new Date("2026-07-21T00:00:00.000Z"),
    completedAt: input.status === "running" || input.status === "pending"
      ? undefined
      : new Date("2026-07-21T00:00:01.000Z"),
  }
}

function createManager(): { manager: BackgroundManager; promptAsyncCalls: PromptAsyncCall[] } {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async (input: PromptAsyncCall) => {
        promptAsyncCalls.push(input)
        return { data: undefined }
      },
      abort: async () => ({ data: undefined }),
    },
  }
  const pluginContext = {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: tmpdir(),
    worktree: tmpdir(),
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }
  const manager = new BackgroundManager({
    pluginContext,
    enableParentSessionNotifications: true,
  })
  managerUnderTest = manager
  return { manager, promptAsyncCalls }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

function getCompletionTimers(manager: BackgroundManager): Map<string, ReturnType<typeof setTimeout>> {
  return Reflect.get(manager, "completionTimers") as Map<string, ReturnType<typeof setTimeout>>
}

async function notify(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (value: BackgroundTask) => Promise<void>
  await notifyParentSession.call(manager, task)
}

describe("BackgroundManager completion notifications", () => {
  test("admits each individual completion once without starting a turn", async () => {
    const { manager, promptAsyncCalls } = createManager()
    const finished = createTask({ id: "task-a", status: "completed" })
    const running = createTask({ id: "task-b", status: "running" })
    getTasks(manager).set(finished.id, finished)
    getTasks(manager).set(running.id, running)
    getPendingByParent(manager).set("parent-1", new Set([finished.id, running.id]))

    await notify(manager, finished)

    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
    expect(promptAsyncCalls[0]?.body.parts?.[0]?.text).toContain("task-a")
    expect(getCompletionTimers(manager).has(finished.id)).toBe(true)
  })

  test("only the final completion starts a parent turn", async () => {
    const { manager, promptAsyncCalls } = createManager()
    const first = createTask({ id: "task-a", status: "completed" })
    const last = createTask({ id: "task-b", status: "completed" })
    getTasks(manager).set(first.id, first)
    getTasks(manager).set(last.id, last)
    getPendingByParent(manager).set("parent-1", new Set([first.id, last.id]))

    await notify(manager, first)
    await notify(manager, last)

    expect(promptAsyncCalls).toHaveLength(2)
    expect(promptAsyncCalls.map((call) => call.body.noReply)).toEqual([true, false])
    expect(promptAsyncCalls[1]?.body.parts?.[0]?.text).toContain("[ALL BACKGROUND TASKS FINISHED]")
  })

  test("a non-final failure follows the same no-reply rule", async () => {
    const { manager, promptAsyncCalls } = createManager()
    const failed = createTask({ id: "task-a", status: "error", error: "provider overloaded" })
    const running = createTask({ id: "task-b", status: "running" })
    getTasks(manager).set(failed.id, failed)
    getTasks(manager).set(running.id, running)
    getPendingByParent(manager).set("parent-1", new Set([failed.id, running.id]))

    await notify(manager, failed)

    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
    expect(promptAsyncCalls[0]?.body.parts?.[0]?.text).toContain("provider overloaded")
  })
})
