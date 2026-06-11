import { afterEach, describe, expect, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { PluginContext } from "../../plugin/types"
import type { OhMyOpenCodeConfig } from "../../config"
import { createContentFilterFallbackHook } from "./hook"

const FROM_MODEL = "opencode/claude-fable-5"
const FALLBACK_MODEL = "bailian-token-plan/qwen3.7-max"

type CapturedPrompt = { body?: Record<string, unknown> }
type CapturedToast = { title?: string; message?: string }

function createCtx(captured: {
  prompts: CapturedPrompt[]
  toasts: CapturedToast[]
}): PluginContext {
  let messagesCall = 0
  return unsafeTestValue<PluginContext>({
    directory: "/tmp/test-omo-content-filter",
    client: {
      session: {
        promptAsync: async (input: { body?: Record<string, unknown> }) => {
          captured.prompts.push({ body: input.body })
          return {}
        },
        messages: async () => {
          messagesCall += 1
          return {
            data: [
              {
                info: { id: `msg_user_${messagesCall}`, role: "user" },
                parts: [{ type: "text", text: `do the thing ${messagesCall}` }],
              },
              {
                info: { id: `msg_asst_${messagesCall}`, role: "assistant", finish: "content-filter" },
                parts: [],
              },
            ],
          }
        },
      },
      tui: {
        showToast: async (input: { body?: CapturedToast }) => {
          captured.toasts.push(input.body ?? {})
          return {}
        },
      },
    },
  })
}

function config(overrides: Partial<NonNullable<OhMyOpenCodeConfig["content_filter_fallback"]>> = {}): OhMyOpenCodeConfig {
  return unsafeTestValue<OhMyOpenCodeConfig>({
    content_filter_fallback: {
      enabled: true,
      from_model: FROM_MODEL,
      fallback_model: FALLBACK_MODEL,
      notify_on_fallback: true,
      ...overrides,
    },
  })
}

function messageUpdated(properties: {
  sessionID: string
  id?: string
  role?: string
  finish?: string
  model?: unknown
  error?: unknown
}): { event: { type: string; properties?: unknown } } {
  const { sessionID, ...info } = properties
  return {
    event: {
      type: "message.updated",
      properties: {
        sessionID,
        info: { sessionID, role: "assistant", model: FROM_MODEL, ...info },
      },
    },
  }
}

let sessionCounter = 0
function nextSession(): string {
  sessionCounter += 1
  return `ses_cff_${sessionCounter}_${Math.random().toString(36).slice(2)}`
}

describe("createContentFilterFallbackHook", () => {
  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given a content-filter finish from the source model #when the event fires #then the turn is re-prompted once on the fallback model", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(1)
    expect(captured.prompts[0]?.body?.model).toEqual({
      providerID: "bailian-token-plan",
      modelID: "qwen3.7-max",
    })
    // re-runs the SAME user message (single-shot replacement of the filtered turn)
    expect(captured.prompts[0]?.body?.messageID).toBe("msg_user_1")
    expect(captured.toasts).toHaveLength(1)
    expect(captured.toasts[0]?.title).toBe("Content Filter Fallback")
  })

  test("#given the source model expressed as an object #when content-filter fires #then it still triggers (dual model shape)", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(
      messageUpdated({
        sessionID,
        id: "msg_asst_1",
        finish: "content-filter",
        model: { providerID: "opencode", id: "claude-fable-5" },
      }),
    )

    expect(captured.prompts).toHaveLength(1)
  })

  test("#given a non-content-filter finish #when the event fires #then nothing is dispatched", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "stop" }))
    await hook.event(messageUpdated({ sessionID, id: "msg_asst_2", finish: "tool-calls" }))

    expect(captured.prompts).toHaveLength(0)
  })

  test("#given content-filter from a DIFFERENT model #when the event fires #then nothing is dispatched", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(
      messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter", model: "openai/gpt-5.5" }),
    )

    expect(captured.prompts).toHaveLength(0)
  })

  test("#given content-filter WITH an error attached #when the event fires #then nothing is dispatched (handled by error-driven paths)", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(
      messageUpdated({
        sessionID,
        id: "msg_asst_1",
        finish: "content-filter",
        error: { name: "SomeError", message: "boom" },
      }),
    )

    expect(captured.prompts).toHaveLength(0)
  })

  test("#given duplicate message.updated for the SAME assistant message #when fired twice #then exactly one retry is dispatched (per-message dedupe)", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))
    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(1)
  })

  test("#given a NEW content-filter message in the same session #when it fires after a prior one #then it is retried again (single-shot is per-occurrence, not per-session)", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), { pluginConfig: config() })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))
    // Simulate turn 1's retry completing (the gate reservation is released when a
    // dispatched turn settles); a real second content-filter only occurs after a
    // full intervening turn.
    releaseAllPromptAsyncReservationsForTesting()
    await hook.event(messageUpdated({ sessionID, id: "msg_asst_2", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(2)
  })

  test("#given the feature is disabled #when content-filter fires #then nothing is dispatched", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), {
      pluginConfig: config({ enabled: false }),
    })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(0)
  })

  test("#given fallback_model is missing #when content-filter fires #then the hook is inert (no dispatch)", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), {
      pluginConfig: config({ fallback_model: undefined }),
    })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(0)
  })

  test("#given notify_on_fallback is false #when content-filter fires #then it retries WITHOUT a toast", async () => {
    const captured = { prompts: [] as CapturedPrompt[], toasts: [] as CapturedToast[] }
    const hook = createContentFilterFallbackHook(createCtx(captured), {
      pluginConfig: config({ notify_on_fallback: false }),
    })
    const sessionID = nextSession()

    await hook.event(messageUpdated({ sessionID, id: "msg_asst_1", finish: "content-filter" }))

    expect(captured.prompts).toHaveLength(1)
    expect(captured.toasts).toHaveLength(0)
  })
})
