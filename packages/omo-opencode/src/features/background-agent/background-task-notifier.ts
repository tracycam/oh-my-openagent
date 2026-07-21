import {
  createInternalAgentTextPart,
  withInternalNoReplyMarker,
} from "../../shared/internal-initiator-marker"

type BackgroundTaskNotificationClient = {
  readonly session: {
    readonly promptAsync: (input: {
      readonly path: { readonly id: string }
      readonly query: { readonly directory: string }
      readonly body: {
        readonly noReply: boolean
        readonly parts: { readonly type: "text"; readonly text: string }[]
      }
    }) => Promise<unknown>
  }
}

/**
 * Admit one completion notification through OpenCode's ordinary user-message
 * queue. OpenCode owns persistence, ordering, and turn scheduling; this layer
 * deliberately has no retry, watchdog, history scan, or delivery state machine.
 */
export async function notifyBackgroundTaskFinished(input: {
  readonly client: BackgroundTaskNotificationClient
  readonly directory: string
  readonly parentSessionID: string
  readonly notification: string
  readonly startNewTurn: boolean
}): Promise<void> {
  const part = createInternalAgentTextPart(input.notification)

  await input.client.session.promptAsync({
    path: { id: input.parentSessionID },
    query: { directory: input.directory },
    body: {
      noReply: !input.startNewTurn,
      parts: [input.startNewTurn ? part : withInternalNoReplyMarker(part)],
    },
  })
}
