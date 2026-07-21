import { describe, expect, test } from "bun:test"
import { buildBackgroundTaskNotificationText } from "./background-task-notification-template"

describe("buildBackgroundTaskNotificationText", () => {
  test("renders an individual completion without waking language", () => {
    const notification = buildBackgroundTaskNotificationText({
      task: { id: "task-1", description: "Index repo", status: "completed" },
      duration: "42s",
      statusText: "COMPLETED",
      allComplete: false,
      remainingCount: 1,
    })

    expect(notification).toContain("[BACKGROUND TASK RESULT READY]")
    expect(notification).toContain("1 task still in progress")
    expect(notification).toContain('background_output(task_id="task-1")')
  })

  test("renders a failed task without pretending it is the final task", () => {
    const notification = buildBackgroundTaskNotificationText({
      task: { id: "task-2", description: "Summarize logs", status: "error", error: "Timed out" },
      duration: "3m 4s",
      statusText: "ERROR",
      allComplete: false,
      remainingCount: 2,
    })

    expect(notification).toContain("[BACKGROUND TASK ERROR]")
    expect(notification).toContain("**Error:** Timed out")
    expect(notification).not.toContain("[ALL BACKGROUND TASKS FINISHED]")
  })

  test("renders only the final task plus the all-finished signal", () => {
    const notification = buildBackgroundTaskNotificationText({
      task: {
        id: "task-3",
        description: "Fallback task",
        status: "completed",
        attempts: [
          {
            attemptId: "att-1",
            attemptNumber: 1,
            sessionId: "ses-primary",
            providerId: "provider-a",
            modelId: "model-a",
            status: "error",
            error: "overloaded",
          },
          {
            attemptId: "att-2",
            attemptNumber: 2,
            sessionId: "ses-fallback",
            providerId: "provider-b",
            modelId: "model-b",
            status: "completed",
          },
        ],
      },
      duration: "10s",
      statusText: "COMPLETED",
      allComplete: true,
      remainingCount: 0,
    })

    expect(notification).toContain("[ALL BACKGROUND TASKS FINISHED]")
    expect(notification).toContain("**ID:** `task-3`")
    expect(notification).toContain("Attempt 1 — ERROR — provider-a/model-a — ses-primary")
    expect(notification).not.toContain("task-1")
    expect(notification).not.toContain("task-2")
  })
})
