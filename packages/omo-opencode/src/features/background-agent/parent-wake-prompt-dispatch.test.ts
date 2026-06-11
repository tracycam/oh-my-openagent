import { describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { PendingParentWake } from "./parent-wake-dedupe"
import {
  RETAINED_WAKE_CONTINUATION_TEXT,
  sendParentWakePrompt,
} from "./parent-wake-prompt-dispatch"

type DispatchInput = Parameters<typeof sendParentWakePrompt>[0]

function createWake(overrides: Partial<PendingParentWake> = {}): PendingParentWake {
  return {
    promptContext: { agent: "sisyphus" },
    notifications: ["[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n- bg_1: research"],
    shouldReply: true,
    ...overrides,
  }
}

function createDispatchInput(
  wake: PendingParentWake,
  capturedBodies: unknown[],
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return unsafeTestValue<DispatchInput>({
    client: {
      session: {
        promptAsync: async (input: { body?: unknown }) => {
          capturedBodies.push(input.body)
          return {}
        },
        messages: async () => ({ data: [] }),
      },
    },
    directory: "/tmp/test-omo",
    sessionID: `parent-dispatch-${Math.random().toString(36).slice(2)}`,
    latestWake: wake,
    emptyAssistantTurnRetry: false,
    toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: true },
    getDispatchedWake: () => undefined,
    hasRecordedPromptAfterDispatch: async () => false,
    trackDispatchedWake: () => {},
    requeueWake: () => {},
    scheduleFlush: () => {},
    ...overrides,
  })
}

function dispatchedText(body: unknown): string {
  const parts = (body as { parts?: Array<{ text?: string }> })?.parts ?? []
  return parts.map((part) => part.text ?? "").join("")
}

describe("sendParentWakePrompt - retained wake content downgrade", () => {
  test("#given reply dispatch of a wake already admitted as noReply #when content is unchanged #then a lightweight continuation is sent instead of the full notification text", async () => {
    const wake = createWake({
      noReplyAdmittedAt: Date.now() - 5_000,
      noReplyAdmittedNotificationCount: 1,
    })
    const bodies: unknown[] = []

    try {
      await sendParentWakePrompt(createDispatchInput(wake, bodies))
    } finally {
      releaseAllPromptAsyncReservationsForTesting()
    }

    expect(bodies).toHaveLength(1)
    const text = dispatchedText(bodies[0])
    expect(text).toContain(RETAINED_WAKE_CONTINUATION_TEXT)
    expect(text).not.toContain("[ALL BACKGROUND TASKS COMPLETE]")
    expect((bodies[0] as { noReply?: boolean }).noReply).toBe(false)
  })

  test("#given notifications grew after the noReply admit #when dispatching the reply wake #then the full notification text is sent", async () => {
    const wake = createWake({
      notifications: ["first notification", "second notification arrived after admit"],
      noReplyAdmittedAt: Date.now() - 5_000,
      noReplyAdmittedNotificationCount: 1,
    })
    const bodies: unknown[] = []

    try {
      await sendParentWakePrompt(createDispatchInput(wake, bodies))
    } finally {
      releaseAllPromptAsyncReservationsForTesting()
    }

    expect(bodies).toHaveLength(1)
    const text = dispatchedText(bodies[0])
    expect(text).toContain("second notification arrived after admit")
    expect(text).not.toContain(RETAINED_WAKE_CONTINUATION_TEXT)
  })

  test("#given a wake never admitted as noReply #when dispatching #then the full notification text is sent", async () => {
    const wake = createWake()
    const bodies: unknown[] = []

    try {
      await sendParentWakePrompt(createDispatchInput(wake, bodies))
    } finally {
      releaseAllPromptAsyncReservationsForTesting()
    }

    expect(bodies).toHaveLength(1)
    expect(dispatchedText(bodies[0])).toContain("[ALL BACKGROUND TASKS COMPLETE]")
  })

  test("#given an admit-only (forceNoReply) dispatch #when sending #then the full notification text is sent even if a prior admit exists", async () => {
    const wake = createWake({
      noReplyAdmittedAt: Date.now() - 5_000,
      noReplyAdmittedNotificationCount: 1,
    })
    const bodies: unknown[] = []

    try {
      await sendParentWakePrompt(createDispatchInput(wake, bodies, { forceNoReply: true, retainPendingWake: true }))
    } finally {
      releaseAllPromptAsyncReservationsForTesting()
    }

    expect(bodies).toHaveLength(1)
    expect(dispatchedText(bodies[0])).toContain("[ALL BACKGROUND TASKS COMPLETE]")
    expect((bodies[0] as { noReply?: boolean }).noReply).toBe(true)
    // and the admit records the notification count for the later downgrade decision
    expect(wake.noReplyAdmittedNotificationCount).toBe(1)
  })
})
