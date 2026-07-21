import type { BackgroundTaskAttempt, BackgroundTaskStatus } from "./types"

export type BackgroundTaskNotificationStatus = "COMPLETED" | "CANCELLED" | "INTERRUPTED" | "ERROR"

export interface BackgroundTaskNotificationTask {
  id: string
  description: string
  status: BackgroundTaskStatus
  error?: string
  attempts?: BackgroundTaskAttempt[]
}

function formatAttemptModel(attempt: BackgroundTaskAttempt): string {
  if (attempt.providerId && attempt.modelId) {
    return `${attempt.providerId}/${attempt.modelId}`
  }

  if (attempt.modelId) {
    return attempt.modelId
  }

  if (attempt.providerId) {
    return attempt.providerId
  }

  return "unknown-model"
}

function formatAttemptTimeline(task: BackgroundTaskNotificationTask): string {
  if (!task.attempts || task.attempts.length <= 1) {
    return ""
  }

  const lines = task.attempts
    .map((attempt) => {
      const attemptLines = [
        `  - Attempt ${attempt.attemptNumber} — ${attempt.status.toUpperCase()} — ${formatAttemptModel(attempt)} — ${attempt.sessionId ?? "unknown"}`,
      ]

      if (attempt.status !== "completed" && attempt.error) {
        attemptLines.push(`    Error: ${attempt.error}`)
      }

      return attemptLines.join("\n")
    })
    .join("\n")

  return `Background task attempts:\n${lines}`
}

export function buildBackgroundTaskNotificationText(input: {
  task: BackgroundTaskNotificationTask
  duration: string
  statusText: BackgroundTaskNotificationStatus
  allComplete: boolean
  remainingCount: number
}): string {
  const { task, duration, statusText, allComplete, remainingCount } = input

  const safeDescription = (t: BackgroundTaskNotificationTask): string => t.description || t.id
  const errorInfo = task.error ? `\n**Error:** ${task.error}` : ""
  const attemptTimeline = formatAttemptTimeline(task)
  const attemptInfo = attemptTimeline ? `\n${attemptTimeline}` : ""

  if (allComplete) {
    return `<system-reminder>
[BACKGROUND TASK ${statusText}]
[ALL BACKGROUND TASKS FINISHED]
**ID:** \`${task.id}\`
**Description:** ${safeDescription(task)}
**Duration:** ${duration}${errorInfo}${attemptInfo}

This was the final active background task. Use \`background_output(task_id="${task.id}")\` to retrieve its result.
</system-reminder>`
  }

  const isFailure = statusText !== "COMPLETED"
  const header = isFailure ? `[BACKGROUND TASK ${statusText}]` : "[BACKGROUND TASK RESULT READY]"

  return `<system-reminder>
${header}
**ID:** \`${task.id}\`
**Description:** ${safeDescription(task)}
**Duration:** ${duration}${errorInfo}${attemptInfo}

**${remainingCount} task${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.
${isFailure ? "**ACTION REQUIRED:** This task failed. Check the error and decide whether to retry, cancel remaining tasks, or continue." : "Do NOT poll - continue productive work."}

Use \`background_output(task_id="${task.id}")\` to retrieve this result when ready.
</system-reminder>`
}
