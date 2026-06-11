import type { OhMyOpenCodeConfig } from "../../config"
import type { PluginContext } from "../../plugin/types"
import { log } from "../../shared/logger"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
import { isContentFilterFallbackCandidate } from "./detect"
import { dispatchContentFilterFallbackRetry } from "./retry"
import {
  clearAllContentFilterState,
  clearContentFilterSession,
  createContentFilterFallbackState,
  markContentFilterHandled,
} from "./state"
import { resolveContentFilterFallbackConfig } from "./types"

const SOURCE = "content-filter-fallback"

export type ContentFilterFallbackHook = {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
  dispose: () => void
}

function shortModelName(model: string): string {
  return model.split("/").pop() || model
}

/**
 * Content-filter fallback hook.
 *
 * Watches `message.updated` for an assistant turn that finished with
 * `content-filter` from the configured source model, and re-runs that single
 * turn on a configured fallback model (a per-prompt model override, so the next
 * turn reverts to the source model). Independent of `runtime_fallback`
 * (error-driven) and `model_fallback` (permanent chain): a content-filter
 * finish is a clean terminal completion that neither of those systems sees.
 */
export function createContentFilterFallbackHook(
  ctx: PluginContext,
  options: { pluginConfig: OhMyOpenCodeConfig },
): ContentFilterFallbackHook {
  const config = resolveContentFilterFallbackConfig(options.pluginConfig.content_filter_fallback)
  const state = createContentFilterFallbackState()

  const event = async (input: { event: { type: string; properties?: unknown } }): Promise<void> => {
    if (!config) {
      return
    }
    const { event: evt } = input

    if (evt.type === "session.deleted") {
      const sessionID = resolveSessionEventID(evt.properties)
      if (sessionID) {
        clearContentFilterSession(state, sessionID)
      }
      return
    }

    if (evt.type !== "message.updated") {
      return
    }

    const props = evt.properties as Record<string, unknown> | undefined
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = resolveMessageEventSessionID(props)
    if (!sessionID) {
      return
    }
    if (!isContentFilterFallbackCandidate(info, config.fromModel)) {
      return
    }

    const messageID = typeof info?.id === "string" ? info.id : undefined
    // De-dupe the multiple message.updated emissions for this terminal message.
    if (!markContentFilterHandled(state, sessionID, messageID)) {
      return
    }
    // Guard against a concurrent re-prompt for the same session.
    if (state.inFlight.has(sessionID)) {
      return
    }

    state.inFlight.add(sessionID)
    try {
      log(`[${SOURCE}] content-filter finish detected; retrying turn on fallback model`, {
        sessionID,
        fromModel: config.fromModel,
        fallbackModel: config.fallbackModel,
      })
      const result = await dispatchContentFilterFallbackRetry({
        client: ctx.client,
        directory: ctx.directory,
        sessionID,
        fallbackModel: config.fallbackModel,
      })
      if (result === "accepted" && config.notifyOnFallback) {
        await ctx.client.tui
          .showToast({
            body: {
              title: "Content Filter Fallback",
              message: `${shortModelName(config.fromModel)} hit a content filter; retrying this turn with ${shortModelName(config.fallbackModel)}. Next turn stays ${shortModelName(config.fromModel)}.`,
              variant: "warning" as const,
              duration: 6000,
            },
          })
          .catch(() => {})
      }
    } finally {
      state.inFlight.delete(sessionID)
    }
  }

  return {
    event,
    dispose: () => clearAllContentFilterState(state),
  }
}
