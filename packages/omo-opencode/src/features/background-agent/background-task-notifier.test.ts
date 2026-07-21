import { describe, expect, mock, test } from "bun:test"
import { notifyBackgroundTaskFinished } from "./background-task-notifier"

describe("notifyBackgroundTaskFinished", () => {
  test("admits one no-reply user message for an individual completion", async () => {
    const promptAsync = mock(async (_input: unknown) => ({ data: undefined }))

    await notifyBackgroundTaskFinished({
      client: { session: { promptAsync } },
      directory: "/work/project",
      parentSessionID: "parent-1",
      notification: "task one finished",
      startNewTurn: false,
    })

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      path: { id: "parent-1" },
      query: { directory: "/work/project" },
      body: {
        noReply: true,
      },
    })
    expect(promptAsync.mock.calls[0]?.[0].body.parts).toHaveLength(1)
    expect(promptAsync.mock.calls[0]?.[0].body.parts[0]?.text).toContain("task one finished")
  })

  test("starts one turn only for the all-finished notification", async () => {
    const promptAsync = mock(async (_input: unknown) => ({ data: undefined }))

    await notifyBackgroundTaskFinished({
      client: { session: { promptAsync } },
      directory: "/work/project",
      parentSessionID: "parent-1",
      notification: "all tasks finished",
      startNewTurn: true,
    })

    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0]?.[0].body.noReply).toBe(false)
  })

  test("propagates admission failure without retrying", async () => {
    const promptAsync = mock(async (_input: unknown) => {
      throw new Error("admission failed")
    })

    await expect(notifyBackgroundTaskFinished({
      client: { session: { promptAsync } },
      directory: "/work/project",
      parentSessionID: "parent-1",
      notification: "task finished",
      startNewTurn: false,
    })).rejects.toThrow("admission failed")

    expect(promptAsync).toHaveBeenCalledTimes(1)
  })
})
