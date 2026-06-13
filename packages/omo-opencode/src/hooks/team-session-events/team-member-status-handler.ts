import type { TeamModeConfig } from "../../config/schema/team-mode"
import { findResolvedMemberSession } from "../../features/team-mode/member-session-resolution"
import { ackMessages } from "../../features/team-mode/team-mailbox/ack"
import { findDeliveredMessageIds, requeuePendingLiveDeliveries } from "../../features/team-mode/team-mailbox/pending-delivery-recovery"
import { loadRuntimeState, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeStateMember } from "../../features/team-mode/types"
import { resolveSessionEventID } from "../../shared/event-session-id"
import { log } from "../../shared/logger"

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>
type TeamMemberStatusHandlerDeps = {
  readonly client?: {
    readonly session?: {
      readonly messages?: (input: { path: { id: string } }) => Promise<unknown>
    }
  }
}

type MemberStatus = RuntimeStateMember["status"]

const IDLE_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running"])
const COMPLETED_TRANSITION_SOURCE_STATUSES: ReadonlySet<MemberStatus> = new Set(["running", "idle", "pending"])

function getSessionIDFromIdleEvent(properties: unknown): string | undefined {
  return resolveSessionEventID(properties)
}

function getSessionIDFromDeletedEvent(properties: unknown): string | undefined {
  return resolveSessionEventID(properties)
}

async function transitionMemberStatus(
  runtimeMember: { teamRunId: string; memberName: string },
  allowedSources: ReadonlySet<MemberStatus>,
  nextStatus: MemberStatus,
  config: TeamModeConfig,
  sessionID: string,
  eventLabel: string,
  options?: { clearPendingInjectedMessageIds?: boolean },
): Promise<void> {
  const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
  const currentEntry = runtimeState.members.find((member) => member.name === runtimeMember.memberName)
  if (currentEntry === undefined) return
  if (!allowedSources.has(currentEntry.status)) return

  await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
    ...currentRuntimeState,
    members: currentRuntimeState.members.map((member) => (
      member.name === runtimeMember.memberName
        ? {
          ...member,
          status: nextStatus,
          ...(options?.clearPendingInjectedMessageIds ? { pendingInjectedMessageIds: [] } : {}),
        }
        : member
    )),
  }), config)

  log(`team member ${eventLabel}`, {
    event: `team-mode-member-${eventLabel}`,
    teamRunId: runtimeState.teamRunId,
    teamName: runtimeState.teamName,
    memberName: runtimeMember.memberName,
    sessionID,
    previousStatus: currentEntry.status,
    nextStatus,
  })
}

async function reconcilePendingLiveDeliveriesOnTerminalSession(input: {
  readonly teamRunId: string
  readonly memberName: string
  readonly sessionID: string
  readonly pendingInjectedMessageIds: readonly string[]
  readonly config: TeamModeConfig
  readonly deps: TeamMemberStatusHandlerDeps | undefined
}): Promise<void> {
  if (input.pendingInjectedMessageIds.length === 0) {
    return
  }
  const deliveredMessageIds = typeof input.deps?.client?.session?.messages === "function"
    ? await findDeliveredMessageIds(input.deps.client, input.sessionID, input.pendingInjectedMessageIds)
    : new Set<string>()
  const ackedMessageIds = input.pendingInjectedMessageIds.filter((messageId) => deliveredMessageIds.has(messageId))
  const requeuedMessageIds = input.pendingInjectedMessageIds.filter((messageId) => !deliveredMessageIds.has(messageId))
  if (ackedMessageIds.length > 0) {
    await ackMessages(input.teamRunId, input.memberName, ackedMessageIds, input.config)
  }
  if (requeuedMessageIds.length > 0) {
    await requeuePendingLiveDeliveries(input.teamRunId, input.memberName, requeuedMessageIds, input.config)
  }
}

export function createTeamMemberStatusHandler(config: TeamModeConfig, deps?: TeamMemberStatusHandlerDeps): HookImpl {
  return async ({ event }: HookInput): Promise<void> => {
    if (event.type === "session.idle") {
      const sessionID = getSessionIDFromIdleEvent(event.properties)
      if (!sessionID) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        await transitionMemberStatus(runtimeMember, IDLE_TRANSITION_SOURCE_STATUSES, "idle", config, sessionID, "idled")
      } catch (error) {
        log("team member status handler failed on session.idle", {
          event: "team-mode-member-status-handler-error",
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionIDFromDeletedEvent(event.properties)
      if (!sessionID) return
      try {
        const runtimeMember = await findResolvedMemberSession(sessionID, config, "team member status handler")
        if (runtimeMember === null) return
        const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
        const currentEntry = runtimeState.members.find((member) => member.name === runtimeMember.memberName)
        if (currentEntry === undefined) return
        if (!COMPLETED_TRANSITION_SOURCE_STATUSES.has(currentEntry.status)) return
        await reconcilePendingLiveDeliveriesOnTerminalSession({
          teamRunId: runtimeState.teamRunId,
          memberName: currentEntry.name,
          sessionID,
          pendingInjectedMessageIds: currentEntry.pendingInjectedMessageIds,
          config,
          deps,
        })
        await transitionMemberStatus(runtimeMember, COMPLETED_TRANSITION_SOURCE_STATUSES, "completed", config, sessionID, "completed", {
          clearPendingInjectedMessageIds: true,
        })
      } catch (error) {
        log("team member status handler failed on session.deleted", {
          event: "team-mode-member-status-handler-error",
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
