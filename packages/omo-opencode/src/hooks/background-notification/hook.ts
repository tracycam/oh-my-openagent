import type { BackgroundManager } from "../../features/background-agent"

interface Event {
  type: string
  properties?: Record<string, unknown>
}

interface EventInput {
  event: Event
}

const FORWARDED_EVENT_TYPES = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "todo.updated",
  "session.idle",
  "session.error",
  "session.deleted",
  "session.status",
])

const FORWARDED_EVENT_PREFIXES = ["session.next."]

function shouldForwardEvent(type: string): boolean {
  return FORWARDED_EVENT_TYPES.has(type)
    || FORWARDED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))
}

export function createBackgroundNotificationHook(manager: BackgroundManager) {
  const eventHandler = async ({ event }: EventInput) => {
    if (!shouldForwardEvent(event.type)) return
    manager.handleEvent(event)
  }

  return {
    event: eventHandler,
  }
}
