import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundTaskConfig, TmuxConfig } from "../../config/schema"
import type { ModelFallbackControllerAccessor } from "../../hooks/model-fallback"
import {
  dispatchInternalPrompt,
  type PromptAsyncGateResult,
} from "../../hooks/shared/prompt-async-gate"
import {
  createInternalAgentTextPart,
  getAgentToolRestrictions,
  isAmbiguousPostDispatchPromptFailure,
  log,
  messagesInDirectory,
  normalizeSDKResponse,
  promptWithRetryInDirectory,
} from "../../shared"
import {
  clearDelegatedChildSessionBootstrap,
  registerDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
import {
  hasMoreFallbacks,
  shouldRetryError,
} from "../../shared/model-error-classifier"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { setSessionTools } from "../../shared/session-tools-store"
import { isInsideTmux } from "../../shared/tmux"
import { clearSessionAgent, setSessionAgent, subagentSessions, updateSessionAgent } from "../claude-code-session-state"
import { getTaskToastManager } from "../task-toast-manager"
import { abortWithTimeout } from "./abort-with-timeout"
import {
  bindAttemptSession,
  ensureCurrentAttempt,
  finalizeAttempt,
  findAttemptBySession,
  getCurrentAttempt,
  startAttempt,
} from "./attempt-lifecycle"
import {
  buildBackgroundTaskNotificationText,
} from "./background-task-notification-template"
import {
  notifyBackgroundTaskFinished,
} from "./background-task-notifier"
import { writeBackgroundTaskMarker } from "./background-task-marker"
import { ConcurrencyManager } from "./concurrency"
import {
  POLLING_INTERVAL_MS,
  type QueueItem,
  TASK_CLEANUP_DELAY_MS,
  TASK_TTL_MS,
} from "./constants"
import { formatDuration } from "./duration-formatter"
import {
  extractErrorMessage,
  extractErrorName,
  extractErrorStatusCode,
  getSessionErrorMessage,
  isRecord,
  isTerminalSessionError,
} from "./error-classifier"
import { tryFallbackRetry } from "./fallback-retry-handler"
import {
  type CircuitBreakerSettings,
  detectRepetitiveToolUse,
  recordToolCall,
  resolveCircuitBreakerSettings,
} from "./loop-detector"
import { registerManagerForCleanup, unregisterManagerForCleanup } from "./process-cleanup"
import { removeTaskToastTracking } from "./remove-task-toast-tracking"
import {
  MIN_SESSION_GONE_POLLS,
  verifySessionExists as verifySessionStillExists,
} from "./session-existence"
import { handleSessionIdleBackgroundEvent } from "./session-idle-event-handler"
import {
  hasOutputSignalFromPart,
  isInternalInitiatorTextPart,
  isMessagePartForSession,
  resolveMessagePartInfo,
  resolveSessionNextPartInfo,
  SESSION_NEXT_EVENT_PREFIX,
} from "./session-stream-activity"
import { isActiveSessionStatus, isTerminalSessionStatus } from "./session-status-classifier"
import { buildFallbackBody, FALLBACK_AGENT, isAgentNotFoundError } from "./spawner"
import {
  createSubagentDepthLimitError,
  getMaxSubagentDepth,
  resolveSubagentSpawnContext,
  type SubagentSpawnContext,
} from "./subagent-spawn-limits"
import { TaskHistory } from "./task-history"
import { checkAndInterruptStaleTasks, pruneStaleTasks, type SessionStatusMap } from "./task-poller"
import { toBackgroundTaskSnapshots } from "./task-snapshot"
import {
  archiveBackgroundTask,
  forgetBackgroundTask,
  getRegisteredBackgroundTask,
  rememberBackgroundTask,
} from "./task-registry"
import type {
  BackgroundTask,
  BackgroundTaskSnapshot,
  LaunchInput,
  ResumeInput,
} from "./types"

type OpencodeClient = PluginInput["client"]

type ResumeTaskSnapshot = {
  status: BackgroundTask["status"]
  completedAt?: Date
  error?: string
  startedAt?: Date
  progress?: BackgroundTask["progress"]
  parentSessionId: string
  parentMessageId: string
  parentModel?: BackgroundTask["parentModel"]
  parentAgent?: string
  parentTools?: Record<string, boolean>
  concurrencyKey?: string
  concurrencyGroup?: string
}

const TERMINAL_BACKGROUND_TASK_STATUSES = new Set<BackgroundTask["status"]>([
  "completed",
  "error",
  "cancelled",
  "interrupt",
])

interface EventProperties {
  sessionID?: string
  info?: { id?: string; sessionID?: string; role?: unknown; error?: unknown; [key: string]: unknown }
  [key: string]: unknown
}

interface Event {
  type: string
  properties?: EventProperties
}

interface Todo {
  content: string
  status: string
  priority: string
  id: string
}

export interface SubagentSessionCreatedEvent {
  sessionID: string
  parentID: string
  title: string
}

export type OnSubagentSessionCreated = (event: SubagentSessionCreatedEvent) => Promise<void>

export interface SubagentSessionDeletedEvent {
  sessionID: string
}

export type OnSubagentSessionDeleted = (event: SubagentSessionDeletedEvent) => Promise<void>

const MAX_TASK_REMOVAL_RESCHEDULES = 6
const MAX_COMPLETED_TASK_ARCHIVE_SIZE = 100

export interface BackgroundManagerConfig {
  pluginContext: PluginInput
  config?: BackgroundTaskConfig
  tmuxConfig?: TmuxConfig
  onSubagentSessionCreated?: OnSubagentSessionCreated
  onSubagentSessionDeleted?: OnSubagentSessionDeleted
  onShutdown?: () => void | Promise<void>
  enableParentSessionNotifications?: boolean
  modelFallbackControllerAccessor?: ModelFallbackControllerAccessor
  log?: typeof log
}

export class BackgroundManager {


  private tasks: Map<string, BackgroundTask>
  private tasksByParentSession: Map<string, Set<string>>
  private pendingByParent: Map<string, Set<string>>
  private client: OpencodeClient
  private directory: string
  private pollingInterval?: ReturnType<typeof setInterval>
  private pollingInFlight = false
  private concurrencyManager: ConcurrencyManager
  private shutdownTriggered = false
  private config?: BackgroundTaskConfig
  private tmuxEnabled: boolean
  private onSubagentSessionCreated?: OnSubagentSessionCreated
  private onSubagentSessionDeleted?: OnSubagentSessionDeleted
  private onShutdown?: () => void | Promise<void>

  private queuesByKey: Map<string, QueueItem[]> = new Map()
  private processingKeys: Set<string> = new Set()
  private completionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private completedTaskArchive: Map<string, BackgroundTask> = new Map()
  private idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private observedOutputSessions: Set<string> = new Set()
  private observedIncompleteTodosBySession: Map<string, boolean> = new Map()
  private rootDescendantCounts: Map<string, number>
  private preStartDescendantReservations: Set<string>
  private enableParentSessionNotifications: boolean
  private modelFallbackControllerAccessor?: ModelFallbackControllerAccessor
  private logger: typeof log
  private loggedSessionStatusUnavailable = false
  readonly taskHistory = new TaskHistory()
  private cachedCircuitBreakerSettings?: CircuitBreakerSettings

  constructor(config: BackgroundManagerConfig) {
    const { pluginContext, ...options } = config
    this.tasks = new Map()
    this.tasksByParentSession = new Map()
    this.pendingByParent = new Map()
    this.client = pluginContext.client
    this.directory = pluginContext.directory
    this.concurrencyManager = new ConcurrencyManager(options.config)
    this.config = options.config
    this.tmuxEnabled = options?.tmuxConfig?.enabled ?? false
    this.onSubagentSessionCreated = options?.onSubagentSessionCreated
    this.onSubagentSessionDeleted = options?.onSubagentSessionDeleted
    this.onShutdown = options?.onShutdown
    this.rootDescendantCounts = new Map()
    this.preStartDescendantReservations = new Set()
    this.enableParentSessionNotifications = options?.enableParentSessionNotifications ?? true
    this.modelFallbackControllerAccessor = options?.modelFallbackControllerAccessor
    this.logger = options?.log ?? log
    this.registerProcessCleanup()
  }

  private async abortSessionWithLogging(sessionID: string, reason: string): Promise<boolean> {
    try {
      const aborted = await abortWithTimeout(this.client, sessionID)
      if (!aborted) {
        log(`[background-agent] Session abort did not complete during ${reason}:`, {
          sessionID,
        })
      }
      return aborted
    } catch (error) {
      log(`[background-agent] Failed to abort session during ${reason}:`, {
        sessionID,
        error,
      })
      return false
    }
  }

  async assertCanSpawn(parentSessionID: string): Promise<SubagentSpawnContext> {
    const spawnContext = await resolveSubagentSpawnContext(this.client, parentSessionID, this.directory)
    const maxDepth = getMaxSubagentDepth(this.config)
    if (spawnContext.childDepth > maxDepth) {
      throw createSubagentDepthLimitError({
        childDepth: spawnContext.childDepth,
        maxDepth,
        parentSessionID,
        rootSessionID: spawnContext.rootSessionID,
      })
    }

    return spawnContext
  }

  async reserveSubagentSpawn(parentSessionID: string): Promise<{
    spawnContext: SubagentSpawnContext
    descendantCount: number
    commit: () => number
    rollback: () => void
  }> {
    const spawnContext = await this.assertCanSpawn(parentSessionID)
    const descendantCount = this.registerRootDescendant(spawnContext.rootSessionID)
    let settled = false

    return {
      spawnContext,
      descendantCount,
      commit: () => {
        settled = true
        return descendantCount
      },
      rollback: () => {
        if (settled) return
        settled = true
        this.unregisterRootDescendant(spawnContext.rootSessionID)
      },
    }
  }

  private registerRootDescendant(rootSessionID: string): number {
    const nextCount = (this.rootDescendantCounts.get(rootSessionID) ?? 0) + 1
    this.rootDescendantCounts.set(rootSessionID, nextCount)
    return nextCount
  }

  private unregisterRootDescendant(rootSessionID: string): void {
    const currentCount = this.rootDescendantCounts.get(rootSessionID) ?? 0
    if (currentCount <= 1) {
      this.rootDescendantCounts.delete(rootSessionID)
      return
    }

    this.rootDescendantCounts.set(rootSessionID, currentCount - 1)
  }

  private markPreStartDescendantReservation(task: BackgroundTask): void {
    this.preStartDescendantReservations.add(task.id)
  }

  private settlePreStartDescendantReservation(task: BackgroundTask): void {
    this.preStartDescendantReservations.delete(task.id)
  }

  private rollbackPreStartDescendantReservation(task: BackgroundTask): void {
    if (!this.preStartDescendantReservations.delete(task.id)) {
      return
    }

    if (!task.rootSessionId) {
      return
    }

    this.unregisterRootDescendant(task.rootSessionId)
  }

  private addTask(task: BackgroundTask): void {
    this.completedTaskArchive.delete(task.id)
    this.tasks.set(task.id, task)
    rememberBackgroundTask(task)
    if (!task.parentSessionId) {
      return
    }

    const taskIDs = this.tasksByParentSession.get(task.parentSessionId) ?? new Set<string>()
    taskIDs.add(task.id)
    this.tasksByParentSession.set(task.parentSessionId, taskIDs)
  }

  private removeTask(task: BackgroundTask): void {
    this.archiveCompletedTask(task)
    archiveBackgroundTask(task)
    this.tasks.delete(task.id)
    this.removeTaskFromParentIndex(task.id, task.parentSessionId)
  }

  private archiveCompletedTask(task: BackgroundTask): void {
    if (!task.sessionId) {
      return
    }
    if (task.status === "running" || task.status === "pending") {
      return
    }

    const archivedTask: BackgroundTask = {
      id: task.id,
      parentSessionId: task.parentSessionId,
      parentMessageId: task.parentMessageId,
      description: task.description,
      prompt: "[redacted]",
      agent: task.agent,
      sessionId: task.sessionId,
      status: task.status,
      queuedAt: task.queuedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      model: task.model,
      error: task.error,
      category: task.category,
    }

    this.completedTaskArchive.set(task.id, archivedTask)
    if (this.completedTaskArchive.size <= MAX_COMPLETED_TASK_ARCHIVE_SIZE) {
      return
    }

    const oldestTaskID = this.completedTaskArchive.keys().next().value
    if (typeof oldestTaskID === "string") {
      this.completedTaskArchive.delete(oldestTaskID)
    }
  }

  private updateTaskParent(task: BackgroundTask, parentSessionID: string): void {
    if (task.parentSessionId === parentSessionID) {
      return
    }

    this.removeTaskFromParentIndex(task.id, task.parentSessionId)
    task.parentSessionId = parentSessionID
    const taskIDs = this.tasksByParentSession.get(parentSessionID) ?? new Set<string>()
    taskIDs.add(task.id)
    this.tasksByParentSession.set(parentSessionID, taskIDs)
  }

  private captureResumeTaskSnapshot(task: BackgroundTask): ResumeTaskSnapshot {
    return {
      status: task.status,
      completedAt: task.completedAt,
      error: task.error,
      startedAt: task.startedAt,
      progress: task.progress,
      parentSessionId: task.parentSessionId,
      parentMessageId: task.parentMessageId,
      parentModel: task.parentModel,
      parentAgent: task.parentAgent,
      parentTools: task.parentTools,
      concurrencyKey: task.concurrencyKey,
      concurrencyGroup: task.concurrencyGroup,
    }
  }

  private restoreTaskAfterSkippedResume(
    task: BackgroundTask,
    snapshot: ResumeTaskSnapshot,
    skippedStatus: Exclude<PromptAsyncGateResult["status"], "dispatched" | "queued" | "failed">,
  ): void {
    log("[background-agent] Restoring task after skipped resume prompt:", {
      taskId: task.id,
      sessionID: task.sessionId,
      skippedStatus,
    })

    this.cleanupPendingByParent(task)

    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
    }

    task.status = snapshot.status
    task.completedAt = snapshot.completedAt
    task.error = snapshot.error
    task.startedAt = snapshot.startedAt
    task.progress = snapshot.progress
    task.parentMessageId = snapshot.parentMessageId
    task.parentModel = snapshot.parentModel
    task.parentAgent = snapshot.parentAgent
    task.parentTools = snapshot.parentTools
    task.concurrencyKey = snapshot.concurrencyKey
    task.concurrencyGroup = snapshot.concurrencyGroup
    this.updateTaskParent(task, snapshot.parentSessionId)

    removeTaskToastTracking(task.id)
    if (task.status !== "running" && task.status !== "pending") {
      this.scheduleTaskRemoval(task.id)
    }
    this.updateBackgroundTaskMarker(task.parentSessionId)
  }

  private removeTaskFromParentIndex(taskID: string, parentSessionID: string | undefined): void {
    if (!parentSessionID) {
      return
    }

    const taskIDs = this.tasksByParentSession.get(parentSessionID)
    if (!taskIDs) {
      return
    }

    taskIDs.delete(taskID)
    if (taskIDs.size === 0) {
      this.tasksByParentSession.delete(parentSessionID)
    }
  }

  async launch(input: LaunchInput): Promise<BackgroundTask> {
    log("[background-agent] launch() called with:", {
      agent: input.agent,
      model: input.model,
      description: input.description,
      parentSessionID: input.parentSessionId,
    })

    if (!input.agent || input.agent.trim() === "") {
      throw new Error("Agent parameter is required")
    }

    input = { ...input, agent: input.agent.trim().replace(/^[\\/"']+|[\\/"']+$/g, "").trim() }

    if (!input.agent) {
      throw new Error("Agent parameter is required after sanitization")
    }

    const spawnReservation = await this.reserveSubagentSpawn(input.parentSessionId)

    try {
      log("[background-agent] spawn guard passed", {
        parentSessionID: input.parentSessionId,
        rootSessionID: spawnReservation.spawnContext.rootSessionID,
        childDepth: spawnReservation.spawnContext.childDepth,
        descendantCount: spawnReservation.descendantCount,
      })

      // Create task immediately with status="pending"
      const task: BackgroundTask = {
        id: `bg_${crypto.randomUUID().slice(0, 8)}`,
        status: "pending",
        queuedAt: new Date(),
        rootSessionId: spawnReservation.spawnContext.rootSessionID,
        // Do NOT set startedAt - will be set when running
        // Do NOT set sessionID - will be set when running
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        spawnDepth: spawnReservation.spawnContext.childDepth,
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        teamRunId: input.teamRunId,
        parentModel: input.parentModel,
        parentAgent: input.parentAgent,
        parentTools: input.parentTools,
        model: input.model,
        fallbackChain: input.fallbackChain,
        skillContent: input.skillContent,
        sessionPermission: input.sessionPermission,
        attemptCount: 0,
        category: input.category,
        onSessionCreated: input.onSessionCreated,
      }
      const firstAttempt = startAttempt(task, input.model)

      this.addTask(task)
      this.taskHistory.record(input.parentSessionId, { id: task.id, agent: input.agent, description: input.description, status: "pending", category: input.category })

      // This set decides whether a terminal admission should start a parent turn.
      if (input.parentSessionId) {
        const pending = this.pendingByParent.get(input.parentSessionId) ?? new Set()
        pending.add(task.id)
        this.pendingByParent.set(input.parentSessionId, pending)
      }

      // Add to queue
      const rawConcurrencyKey = this.getRawConcurrencyKeyFromInput(input)
      const key = this.concurrencyManager.getConcurrencyKey(rawConcurrencyKey)
      const queue = this.queuesByKey.get(key) ?? []
      queue.push({ task, input, attemptID: firstAttempt.attemptId, rawConcurrencyKey })
      this.queuesByKey.set(key, queue)

      log("[background-agent] Task queued:", { taskId: task.id, key, queueLength: queue.length })

      const toastManager = getTaskToastManager()
      if (toastManager) {
        toastManager.addTask({
          id: task.id,
          description: input.description,
          agent: input.agent,
          isBackground: true,
          status: "queued",
          skills: input.skills,
        })
      }

      spawnReservation.commit()
      this.markPreStartDescendantReservation(task)

      // Signal CLI run mode that background tasks are active
      this.updateBackgroundTaskMarker(input.parentSessionId)

      // Trigger processing (fire-and-forget)
      void this.processKey(key)

      return { ...task }
    } catch (error) {
      spawnReservation.rollback()
      throw error
    }
  }

  private async processKey(key: string): Promise<void> {
    if (this.processingKeys.has(key)) {
      return
    }

    this.processingKeys.add(key)

    try {
      const queue = this.queuesByKey.get(key)
      while (queue && queue.length > 0) {
        const item = queue.shift()
        if (!item) {
          continue
        }

        try {
          await this.concurrencyManager.acquire(item.rawConcurrencyKey ?? key, item.task.id)
        } catch (error) {
          if (item.task.status === "cancelled" || item.task.status === "error" || item.task.status === "interrupt") {
            this.rollbackPreStartDescendantReservation(item.task)
            continue
          }
          throw error
        }

        if (item.task.status === "cancelled" || item.task.status === "error" || item.task.status === "interrupt") {
          this.rollbackPreStartDescendantReservation(item.task)
          this.concurrencyManager.release(key)
          continue
        }

        try {
          await this.startTask(item)
        } catch (error) {
          log("[background-agent] Error starting task:", error)
          this.rollbackPreStartDescendantReservation(item.task)

          // Mark task as error so the parent polling loop detects the failure
          // instead of leaving it in a zombie "running" state with no prompt sent
          if (item.task.currentAttemptID) {
            finalizeAttempt(item.task, item.task.currentAttemptID, "error", error instanceof Error ? error.message : String(error))
          } else {
            item.task.status = "error"
            item.task.error = error instanceof Error ? error.message : String(error)
            item.task.completedAt = new Date()
          }

          if (item.task.concurrencyKey) {
            this.concurrencyManager.release(item.task.concurrencyKey)
            item.task.concurrencyKey = undefined
          } else {
            this.concurrencyManager.release(key)
          }

          removeTaskToastTracking(item.task.id)

          // Abort the orphaned session if one was created before the error
          if (item.task.sessionId) {
            clearDelegatedChildSessionBootstrap(item.task.sessionId)
            await this.abortSessionWithLogging(item.task.sessionId, "startTask error cleanup")
          }

          // Update continuation marker for CLI run mode
          this.updateBackgroundTaskMarker(item.task.parentSessionId)

          await this.notifyParentSession(item.task).catch(err => {
            log("[background-agent] Failed to notify on startTask error:", err)
          })
        }
      }
    } finally {
      this.processingKeys.delete(key)
    }
  }

  private async startTask(item: QueueItem): Promise<void> {
    const { task, input } = item
    const attemptID = item.attemptID ?? ensureCurrentAttempt(task, input.model).attemptId

    log("[background-agent] Starting task:", {
      taskId: task.id,
      agent: input.agent,
      model: input.model,
    })

    const concurrencyKey = this.getConcurrencyKeyFromInput(input)

    const parentSession = await this.client.session.get({
      path: { id: input.parentSessionId },
      query: { directory: this.directory },
    }).catch((err) => {
      log(`[background-agent] Failed to get parent session: ${err}`)
      return null
    })
    const parentDirectory = parentSession?.data?.directory ?? this.directory
    log(`[background-agent] Parent dir: ${parentSession?.data?.directory}, using: ${parentDirectory}`)

    const createResult = await this.client.session.create({
      body: {
        parentID: input.parentSessionId,
        title: `${input.description} (@${input.agent} subagent)`,
        ...(input.sessionPermission ? { permission: input.sessionPermission } : {}),
        ...(input.model
          ? {
              model: {
                id: input.model.modelID,
                providerID: input.model.providerID,
                ...(input.model.variant ? { variant: input.model.variant } : {}),
              },
            }
          : {}),
      } as Record<string, unknown>,
      query: {
        directory: parentDirectory,
      },
    })

    if (createResult.error) {
      throw new Error(`Failed to create background session: ${createResult.error}`)
    }

    if (!createResult.data?.id) {
      throw new Error("Failed to create background session: API returned no session ID")
    }

    const sessionID = createResult.data.id

    if (task.status === "cancelled") {
      clearDelegatedChildSessionBootstrap(sessionID)
      await this.abortSessionWithLogging(sessionID, "cancelled pre-start cleanup")
      this.concurrencyManager.release(concurrencyKey)
      return
    }

    await input.onSessionCreated?.(sessionID)
    this.settlePreStartDescendantReservation(task)
    subagentSessions.add(sessionID)
    setSessionAgent(sessionID, input.agent)

    if (this.tasks.get(task.id)?.status === "cancelled") {
      clearDelegatedChildSessionBootstrap(sessionID)
      clearSessionAgent(sessionID)
      await this.abortSessionWithLogging(sessionID, "cancelled during launch setup")
      subagentSessions.delete(sessionID)
      if (task.rootSessionId) {
        this.unregisterRootDescendant(task.rootSessionId)
      }
      this.concurrencyManager.release(concurrencyKey)
      return
    }

    const boundAttempt = bindAttemptSession(task, attemptID, sessionID, input.model)
    if (!boundAttempt) {
      clearDelegatedChildSessionBootstrap(sessionID)
      clearSessionAgent(sessionID)
      await this.abortSessionWithLogging(sessionID, "stale attempt binding cleanup")
      subagentSessions.delete(sessionID)
      if (task.rootSessionId) {
        this.unregisterRootDescendant(task.rootSessionId)
      }
      this.concurrencyManager.release(concurrencyKey)
      return
    }

    task.progress = {
      toolCalls: 0,
      lastUpdate: new Date(),
    }
    task.concurrencyKey = concurrencyKey
    task.concurrencyGroup = concurrencyKey

    this.taskHistory.record(input.parentSessionId, { id: task.id, sessionID, agent: input.agent, description: input.description, status: "running", category: input.category, startedAt: task.startedAt })
    this.startPolling()

    // Fire-and-forget prompt via promptAsync (no response body needed)
    // OpenCode prompt payload accepts model provider/model IDs and top-level variant only.
    // Temperature/topP and provider-specific options are applied through chat.params.
    const launchModel = input.model
      ? {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        }
      : undefined
    const launchVariant = input.model?.variant

    if (input.model) {
      applySessionPromptParams(sessionID, input.model)
    }

    const userDenied: Record<string, boolean> = {}
    if (input.userPermission) {
      for (const [tool, value] of Object.entries(input.userPermission)) {
        if (value === "deny") userDenied[tool] = false
      }
    }

    const launchTools = {
      task: false,
      call_omo_agent: true,
      question: false,
      ...userDenied,
      ...getAgentToolRestrictions(input.agent, {
        includeTeamToolDenylist: input.teamRunId === undefined,
      }),
    }
    setSessionTools(sessionID, launchTools)

    log("[background-agent] Launching task:", { taskId: task.id, sessionID, agent: input.agent })
    registerDelegatedChildSessionBootstrap({
      sessionID,
      promptText: input.prompt,
      fallbackChain: input.fallbackChain,
      category: input.category,
      system: input.skillContent,
      tools: launchTools,
      modelFallbackControllerAccessor: this.modelFallbackControllerAccessor,
    })

    const toastManager = getTaskToastManager()
    if (toastManager) {
      toastManager.updateTask(task.id, "running")
    }

    log("[background-agent] Calling prompt (fire-and-forget) for launch with:", {
      sessionID,
      agent: input.agent,
      model: input.model,
      hasSkillContent: !!input.skillContent,
      promptLength: input.prompt.length,
    })

    const promptBody = {
      agent: input.agent,
      ...(launchModel ? { model: launchModel } : {}),
      ...(launchVariant ? { variant: launchVariant } : {}),
      system: input.skillContent,
      tools: launchTools,
      parts: [createInternalAgentTextPart(input.prompt)],
    }

    promptWithRetryInDirectory(this.client, {
      path: { id: sessionID },
      body: promptBody,
    }, parentDirectory).catch(async (error) => {
      // Retry with fallback agent if the original agent was unregistered (e.g., after a model switch)
      if (isAgentNotFoundError(error) && input.agent !== FALLBACK_AGENT) {
        log("[background-agent] Agent not found, retrying with fallback agent", {
          original: input.agent,
          fallback: FALLBACK_AGENT,
          taskId: task.id,
        })
        try {
          const fallbackBody = buildFallbackBody(promptBody, FALLBACK_AGENT, {
            includeTeamToolDenylist: input.teamRunId === undefined,
          })
          const fallbackTools = fallbackBody.tools as Record<string, boolean>
          setSessionTools(sessionID, fallbackTools)
          updateSessionAgent(sessionID, FALLBACK_AGENT)
          registerDelegatedChildSessionBootstrap({
            sessionID,
            promptText: input.prompt,
            fallbackChain: input.fallbackChain,
            category: input.category,
            system: input.skillContent,
            tools: fallbackTools,
            modelFallbackControllerAccessor: this.modelFallbackControllerAccessor,
          })
          await promptWithRetryInDirectory(this.client, {
            path: { id: sessionID },
            body: fallbackBody,
          }, parentDirectory)
          task.agent = FALLBACK_AGENT
          return
        } catch (retryError) {
          log("[background-agent] Fallback agent also failed:", retryError)
        }
      }

      log("[background-agent] promptAsync error:", error)
      const resolvedTask = this.resolveTaskAttemptBySession(sessionID)
      const existingTask = resolvedTask?.task
      if (resolvedTask && !resolvedTask.isCurrent) {
        log("[background-agent] Ignoring prompt error from stale attempt session", {
          sessionID,
          currentAttemptID: resolvedTask.task.currentAttemptID,
          attemptID: resolvedTask.attemptID,
        })
        return
      }
      if (existingTask) {
        const errorInfo = {
          name: extractErrorName(error),
          message: extractErrorMessage(error),
          statusCode: extractErrorStatusCode(error),
        }
        if (await this.tryFallbackRetry(existingTask, errorInfo, "promptAsync.launch")) {
          return
        }

        const errorMessage = errorInfo.message ?? (error instanceof Error ? error.message : String(error))
        const terminalError = errorMessage.includes("agent.name") || errorMessage.includes("undefined") || isAgentNotFoundError(error)
          ? `Agent "${input.agent}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`
          : errorMessage
        if (existingTask.currentAttemptID) {
          finalizeAttempt(existingTask, existingTask.currentAttemptID, "interrupt", terminalError)
        } else {
          existingTask.status = "interrupt"
          existingTask.error = terminalError
          existingTask.completedAt = new Date()
        }
        if (existingTask.rootSessionId) {
          this.unregisterRootDescendant(existingTask.rootSessionId)
        }
        if (existingTask.concurrencyKey) {
          this.concurrencyManager.release(existingTask.concurrencyKey)
          existingTask.concurrencyKey = undefined
        }

        removeTaskToastTracking(existingTask.id)

        // Abort the session to prevent infinite polling hang
        // Awaited to prevent dangling promise during subagent teardown (Bun/WebKit SIGABRT)
        clearDelegatedChildSessionBootstrap(sessionID)
        await this.abortSessionWithLogging(sessionID, "launch error cleanup")

        await this.notifyParentSession(existingTask).catch(err => {
          log("[background-agent] Failed to notify on error:", err)
        })
      }
    })

    log("[background-agent] tmux callback check", {
      hasCallback: !!this.onSubagentSessionCreated,
      tmuxEnabled: this.tmuxEnabled,
      isInsideTmux: isInsideTmux(),
      sessionID,
      parentID: input.parentSessionId,
    })

    if (!input.suppressTmuxSpawn && this.onSubagentSessionCreated && this.tmuxEnabled && isInsideTmux()) {
      log("[background-agent] Invoking tmux callback (fire-and-forget)", { sessionID })
      void this.onSubagentSessionCreated({
        sessionID,
        parentID: input.parentSessionId,
        title: input.description,
      }).catch((err) => {
        log("[background-agent] Failed to spawn tmux pane:", err)
      })
    } else {
      log("[background-agent] SKIP tmux callback - conditions not met", {
        suppressTmuxSpawn: !!input.suppressTmuxSpawn,
      })
    }
  }

  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id) ?? this.completedTaskArchive.get(id) ?? getRegisteredBackgroundTask(id)
  }

  getTasksSnapshot(): BackgroundTaskSnapshot[] { return toBackgroundTaskSnapshots(this.tasks.values()) }

  getTasksByParentSession(sessionID: string): BackgroundTask[] {
    const taskIDs = this.tasksByParentSession.get(sessionID)
    if (!taskIDs) {
      const result: BackgroundTask[] = []
      for (const task of this.tasks.values()) {
        if (task.parentSessionId === sessionID) {
          result.push(task)
        }
      }
      return result
    }

    const tasks: BackgroundTask[] = []
    for (const taskID of taskIDs) {
      const task = this.tasks.get(taskID)
      if (task) {
        tasks.push(task)
      }
    }
    return tasks
  }

  /**
   * Return whether a session has direct child background tasks still in flight.
   *
   * Intentionally checks immediate children only, not all descendants. A
   * grandchild's completion wake is addressed to its immediate parent session,
   * never to this ancestor, so blocking on descendants would make the sync poll
   * loop wait for grandchildren it can never be woken for (returning a stale
   * pre-grandchild turn after the settle window, or hitting the sync timeout for
   * long-running descendants). When a deliverable genuinely depends on a
   * grandchild, the direct child stays running until that grandchild resolves, so
   * the immediate-child check already covers it; when the child fire-and-forgets
   * a grandchild, this session correctly does not wait for work it cannot consume.
   */
  hasActiveChildTasks(sessionID: string): boolean {
    return this.getTasksByParentSession(sessionID).some(t => t.status === "running" || t.status === "pending")
  }

  private updateBackgroundTaskMarker(parentSessionID: string): void {
    const tasks = this.getTasksByParentSession(parentSessionID)
    const activeTasks = tasks.filter(t => t.status === "running" || t.status === "pending")
    writeBackgroundTaskMarker({
      directory: this.directory,
      parentSessionID,
      activeTaskCount: activeTasks.length,
    })
  }

  getAllDescendantTasks(sessionID: string): BackgroundTask[] {
    const result: BackgroundTask[] = []
    const directChildren = this.getTasksByParentSession(sessionID)

    for (const child of directChildren) {
      result.push(child)
      if (child.sessionId) {
        const descendants = this.getAllDescendantTasks(child.sessionId)
        result.push(...descendants)
      }
    }

    return result
  }

  findBySession(sessionID: string): BackgroundTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionID) {
        return task
      }
      if (findAttemptBySession(task, sessionID)) {
        return task
      }
    }
    return undefined
  }

  private resolveTaskAttemptBySession(sessionID: string): { task: BackgroundTask; attemptID?: string; isCurrent: boolean } | undefined {
    const task = this.findBySession(sessionID)
    if (!task) {
      return undefined
    }

    const attempt = findAttemptBySession(task, sessionID)
    if (!attempt) {
      return {
        task,
        attemptID: undefined,
        isCurrent: task.sessionId === sessionID,
      }
    }

    return {
      task,
      attemptID: attempt.attemptId,
      isCurrent: task.currentAttemptID === attempt.attemptId,
    }
  }

  private getConcurrencyKeyFromInput(input: LaunchInput): string {
    return this.concurrencyManager.getConcurrencyKey(this.getRawConcurrencyKeyFromInput(input))
  }

  private getRawConcurrencyKeyFromInput(input: LaunchInput): string {
    const modelKey = input.model
      ? `${input.model.providerID}/${input.model.modelID}`
      : input.agent

    return modelKey
  }

  private getRawConcurrencyKeyFromTask(task: Pick<BackgroundTask, "model" | "agent">): string {
    return task.model
      ? `${task.model.providerID}/${task.model.modelID}`
      : task.agent
  }

  /** Track a task created elsewhere (for example, from the built-in task tool). */
  async trackTask(input: {
    taskId: string
    sessionId: string
    parentSessionId: string
    description: string
    agent?: string
    parentAgent?: string
    concurrencyKey?: string
  }): Promise<BackgroundTask> {
    const existingTask = this.tasks.get(input.taskId)
    if (existingTask) {
      // P2 fix: Clean up old parent's pending set BEFORE changing parent
      // Otherwise cleanupPendingByParent would use the new parent ID
      const parentChanged = input.parentSessionId !== existingTask.parentSessionId
      if (parentChanged) {
        this.cleanupPendingByParent(existingTask)  // Clean from OLD parent
        this.updateTaskParent(existingTask, input.parentSessionId)
      }
      if (input.parentAgent !== undefined) {
        existingTask.parentAgent = input.parentAgent
      }
      if (!existingTask.concurrencyGroup) {
        existingTask.concurrencyGroup = input.concurrencyKey
          ? this.concurrencyManager.getConcurrencyKey(input.concurrencyKey)
          : existingTask.agent
      }

      if (existingTask.sessionId) {
        subagentSessions.add(existingTask.sessionId)
      }
      this.startPolling()

      // Include active external tasks in the parent's all-finished decision.
      if (existingTask.status === "pending" || existingTask.status === "running") {
        const pending = this.pendingByParent.get(input.parentSessionId) ?? new Set()
        pending.add(existingTask.id)
        this.pendingByParent.set(input.parentSessionId, pending)
      } else if (!parentChanged) {
        // Only clean up if parent didn't change (already cleaned above if it did)
        this.cleanupPendingByParent(existingTask)
      }

      log("[background-agent] External task already registered:", { taskId: existingTask.id, sessionID: existingTask.sessionId, status: existingTask.status })

      return existingTask
    }

    const concurrencyKey = input.concurrencyKey
      ? this.concurrencyManager.getConcurrencyKey(input.concurrencyKey)
      : undefined
    const concurrencyGroup = concurrencyKey ?? input.agent ?? "task"

    // Acquire concurrency slot if a key is provided
    if (concurrencyKey) {
      await this.concurrencyManager.acquire(concurrencyKey)
    }

    const task: BackgroundTask = {
      id: input.taskId,
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
      parentMessageId: "",
      description: input.description,
      prompt: "",
      agent: input.agent || "task",
      status: "running",
      startedAt: new Date(),
      progress: {
        toolCalls: 0,
        lastUpdate: new Date(),
      },
      parentAgent: input.parentAgent,
      concurrencyKey,
      concurrencyGroup,
    }

    this.addTask(task)
    subagentSessions.add(input.sessionId)
    this.startPolling()
    this.taskHistory.record(input.parentSessionId, { id: task.id, sessionID: input.sessionId, agent: input.agent || "task", description: input.description, status: "running", startedAt: task.startedAt })

    if (input.parentSessionId) {
      const pending = this.pendingByParent.get(input.parentSessionId) ?? new Set()
      pending.add(task.id)
      this.pendingByParent.set(input.parentSessionId, pending)
    }

    log("[background-agent] Registered external task:", { taskId: task.id, sessionID: input.sessionId })

    return task
  }

  async resume(input: ResumeInput): Promise<BackgroundTask> {
    const existingTask = this.findBySession(input.sessionId)
    if (!existingTask) {
      throw new Error(`Task not found for session: ${input.sessionId}`)
    }

    if (!existingTask.sessionId) {
      throw new Error(`Task has no sessionID: ${existingTask.id}`)
    }

    if (existingTask.status === "running") {
      throw new Error(
        `Task ${existingTask.id} is currently running and cannot accept a continuation prompt. ` +
        "Wait for it to complete before resuming it with task_id.",
      )
    }

    const resumeSnapshot = this.captureResumeTaskSnapshot(existingTask)
    const completionTimer = this.completionTimers.get(existingTask.id)
    if (completionTimer) {
      clearTimeout(completionTimer)
      this.completionTimers.delete(existingTask.id)
    }

    // Re-acquire concurrency using the persisted concurrency group
    const concurrencyKey = this.concurrencyManager.getConcurrencyKey(
      existingTask.concurrencyGroup ?? existingTask.agent,
    )
    await this.concurrencyManager.acquire(concurrencyKey)
    existingTask.concurrencyKey = concurrencyKey
    existingTask.concurrencyGroup = concurrencyKey


    existingTask.status = "running"
    existingTask.completedAt = undefined
    existingTask.error = undefined
    this.updateTaskParent(existingTask, input.parentSessionId)
    existingTask.parentMessageId = input.parentMessageId
    existingTask.parentModel = input.parentModel
    existingTask.parentAgent = input.parentAgent
    if (input.parentTools) {
      existingTask.parentTools = input.parentTools
    }
    // Reset startedAt on resume to prevent immediate completion
    // The MIN_IDLE_TIME_MS check uses startedAt, so resumed tasks need fresh timing
    existingTask.startedAt = new Date()

    existingTask.progress = {
      toolCalls: existingTask.progress?.toolCalls ?? 0,
      toolCallWindow: existingTask.progress?.toolCallWindow,
      countedToolPartIDs: existingTask.progress?.countedToolPartIDs,
      lastUpdate: new Date(),
    }

    this.startPolling()
    if (existingTask.sessionId) {
      subagentSessions.add(existingTask.sessionId)
    }

    if (input.parentSessionId) {
      const pending = this.pendingByParent.get(input.parentSessionId) ?? new Set()
      pending.add(existingTask.id)
      this.pendingByParent.set(input.parentSessionId, pending)
    }

    const toastManager = getTaskToastManager()
    if (toastManager) {
      toastManager.addTask({
        id: existingTask.id,
        description: existingTask.description,
        agent: existingTask.agent,
        isBackground: true,
      })
    }

    log("[background-agent] Resuming task:", { taskId: existingTask.id, sessionID: existingTask.sessionId })

    log("[background-agent] Resuming task - calling prompt (fire-and-forget) with:", {
      sessionID: existingTask.sessionId,
      agent: existingTask.agent,
      model: existingTask.model,
      promptLength: input.prompt.length,
    })

    // Fire-and-forget prompt via promptAsync (no response body needed)
    // Resume uses the same PromptInput contract as launch: model IDs plus top-level variant.
    const resumeModel = existingTask.model
      ? {
          providerID: existingTask.model.providerID,
          modelID: existingTask.model.modelID,
        }
      : undefined
    const resumeVariant = existingTask.model?.variant

    if (existingTask.model) {
      applySessionPromptParams(existingTask.sessionId!, existingTask.model)
    }

    dispatchInternalPrompt({
      mode: "async",
      client: this.client,
      sessionID: existingTask.sessionId,
      source: "background-agent-resume",
      settleMs: 0,
      queueBehavior: "defer",
      input: {
        path: { id: existingTask.sessionId },
        body: {
          agent: existingTask.agent,
          ...(resumeModel ? { model: resumeModel } : {}),
          ...(resumeVariant ? { variant: resumeVariant } : {}),
          tools: (() => {
            const tools = {
              task: false,
              call_omo_agent: true,
              question: false,
              ...getAgentToolRestrictions(existingTask.agent, {
                includeTeamToolDenylist: existingTask.teamRunId === undefined,
              }),
            }
            setSessionTools(existingTask.sessionId!, tools)
            return tools
          })(),
          parts: [createInternalAgentTextPart(input.prompt)],
        },
        query: { directory: this.directory },
      },
    }).then((promptResult) => {
      if (promptResult.status === "failed") {
        if (isAmbiguousPostDispatchPromptFailure(promptResult)) {
          log("[background-agent] resume prompt may have been accepted before ambiguous failure; continuing to poll", {
            taskId: existingTask.id,
            sessionID: existingTask.sessionId,
            error: promptResult.error instanceof Error ? promptResult.error.message : String(promptResult.error),
          })
          return
        }
        throw promptResult.error
      }
      if (promptResult.status === "queued") {
        log("[background-agent] resume prompt queued by prompt dispatcher:", {
          taskId: existingTask.id,
          sessionID: existingTask.sessionId,
          queuedBy: promptResult.queuedBy,
        })
        return
      }
      if (promptResult.status !== "dispatched") {
        log("[background-agent] resume prompt skipped by promptAsync gate:", {
          taskId: existingTask.id,
          sessionID: existingTask.sessionId,
          status: promptResult.status,
        })
        this.restoreTaskAfterSkippedResume(existingTask, resumeSnapshot, promptResult.status)
      }
    }).catch(async (error) => {
      log("[background-agent] resume prompt error:", error)
      const errorInfo = {
        name: extractErrorName(error),
        message: extractErrorMessage(error),
        statusCode: extractErrorStatusCode(error),
      }
      if (await this.tryFallbackRetry(existingTask, errorInfo, "promptAsync.resume")) {
        return
      }

      existingTask.status = "interrupt"
      const errorMessage = errorInfo.message ?? (error instanceof Error ? error.message : String(error))
      existingTask.error = errorMessage
      existingTask.completedAt = new Date()
      if (existingTask.rootSessionId) {
        this.unregisterRootDescendant(existingTask.rootSessionId)
      }

      // Release concurrency on error to prevent slot leaks
      if (existingTask.concurrencyKey) {
        this.concurrencyManager.release(existingTask.concurrencyKey)
        existingTask.concurrencyKey = undefined
      }

      removeTaskToastTracking(existingTask.id)

      // Abort the session to prevent infinite polling hang
      // Awaited to prevent dangling promise during subagent teardown (Bun/WebKit SIGABRT)
      if (existingTask.sessionId) {
        clearDelegatedChildSessionBootstrap(existingTask.sessionId)
        await this.abortSessionWithLogging(existingTask.sessionId, "resume error cleanup")
      }

      await this.notifyParentSession(existingTask).catch(err => {
        log("[background-agent] Failed to notify on resume error:", err)
      })
    })

    return existingTask
  }

  private async checkSessionTodos(sessionID: string): Promise<boolean> {
    const observedIncompleteTodos = this.observedIncompleteTodosBySession.get(sessionID)
    if (observedIncompleteTodos === false) {
      return false
    }

    try {
      const response = await this.client.session.todo({
        path: { id: sessionID },
      })
      const todos = normalizeSDKResponse(response, [] as Todo[], { preferResponseOnMissingData: true })
      if (!todos || todos.length === 0) {
        this.observedIncompleteTodosBySession.set(sessionID, false)
        return false
      }

      const incomplete = todos.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled"
      )
      const hasIncompleteTodos = incomplete.length > 0
      this.observedIncompleteTodosBySession.set(sessionID, hasIncompleteTodos)
      return hasIncompleteTodos
    } catch (error) {
      log("[background-agent] Failed to check session todos:", {
        sessionID,
        error,
      })
      return false
    }
  }

  private markSessionOutputObserved(sessionID: string): void {
    this.observedOutputSessions.add(sessionID)
  }

  private clearSessionOutputObserved(sessionID: string): void {
    this.observedOutputSessions.delete(sessionID)
  }

  private clearSessionTodoObservation(sessionID: string): void {
    this.observedIncompleteTodosBySession.delete(sessionID)
  }

  handleEvent(event: Event): void {
    const props = event.properties

    if (event.type.startsWith(SESSION_NEXT_EVENT_PREFIX)) {
      const sessionID = resolveSessionEventID(props)
      const partInfo = resolveSessionNextPartInfo(event.type, props)
      if (!sessionID || !partInfo) return

      this.handleEvent({
        type: "message.part.updated",
        properties: { sessionID, part: partInfo },
      })
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info
      if (!isRecord(info)) return

      const sessionID = resolveMessageEventSessionID(props)
      const role = info.role
      if (!sessionID) return

      if (role === "tool") {
        this.markSessionOutputObserved(sessionID)
      }

      if (role !== "assistant") return

      const resolved = this.resolveTaskAttemptBySession(sessionID)
      if (!resolved?.isCurrent) return

      const { task } = resolved
      if (task.status !== "running") return

      const assistantError = info.error
      if (!assistantError) return

      const errorInfo = {
        name: extractErrorName(assistantError),
        message: extractErrorMessage(assistantError),
        statusCode: extractErrorStatusCode(assistantError),
      }
      void this.tryFallbackRetry(task, errorInfo, "message.updated").catch((error) => {
        log("[background-agent] Error handling message.updated fallback retry:", {
          error,
          taskId: task.id,
        })
      })
    }

    if (event.type === "message.part.updated" || event.type === "message.part.delta") {
      const partInfo = resolveMessagePartInfo(props)
      const sessionID = resolveMessageEventSessionID(props)
      if (!sessionID) return
      if (!isMessagePartForSession(partInfo, sessionID)) return
      const isUserPart = partInfo?.role === "user"
      const isInternalWakePart = isInternalInitiatorTextPart(partInfo, sessionID)
      const hasTaskOutput = hasOutputSignalFromPart(partInfo, sessionID)
        && !isUserPart
        && !isInternalWakePart

      const resolved = this.resolveTaskAttemptBySession(sessionID)
      if (!resolved?.isCurrent) return

      const { task } = resolved

      if (hasTaskOutput) {
        this.markSessionOutputObserved(sessionID)
      }

      // Clear any pending idle deferral timer since the task is still active
      const existingTimer = this.idleDeferralTimers.get(task.id)
      if (existingTimer) {
        clearTimeout(existingTimer)
        this.idleDeferralTimers.delete(task.id)
      }

      if (!task.progress) {
        task.progress = {
          toolCalls: 0,
          lastUpdate: partInfo?.activityTime ?? new Date(),
        }
      }
      task.progress.lastUpdate = partInfo?.activityTime ?? new Date()

      if (partInfo?.type === "tool" || partInfo?.tool) {
        if (partInfo.id) {
          const countedToolPartIDs = task.progress.countedToolPartIDs ?? new Set<string>()
          if (countedToolPartIDs.has(partInfo.id)) return
          countedToolPartIDs.add(partInfo.id)
          task.progress.countedToolPartIDs = countedToolPartIDs
        }

        task.progress.toolCalls += 1
        task.progress.lastTool = partInfo.tool
        const circuitBreaker = this.cachedCircuitBreakerSettings ?? resolveCircuitBreakerSettings(this.config)
        this.cachedCircuitBreakerSettings = circuitBreaker
        if (partInfo.tool) {
          const toolInput = partInfo.state?.input ?? partInfo.input
          task.progress.toolCallWindow = recordToolCall(
            task.progress.toolCallWindow,
            partInfo.tool,
            circuitBreaker,
            toolInput
          )

          if (circuitBreaker.enabled) {
            const loopDetection = detectRepetitiveToolUse(task.progress.toolCallWindow)
            if (loopDetection.triggered) {
              log("[background-agent] Circuit breaker: consecutive tool usage detected", {
                taskId: task.id,
                agent: task.agent,
                sessionID,
                toolName: loopDetection.toolName,
                repeatedCount: loopDetection.repeatedCount,
              })
              void this.cancelTask(task.id, {
                source: "circuit-breaker",
                reason: `Subagent called ${loopDetection.toolName} ${loopDetection.repeatedCount} consecutive times (threshold: ${circuitBreaker.consecutiveThreshold}). This usually indicates an infinite loop. The task was automatically cancelled to prevent excessive token usage.`,
              })
              return
            }
          }
        }

        const maxToolCalls = circuitBreaker.maxToolCalls
        if (task.progress.toolCalls >= maxToolCalls) {
          log("[background-agent] Circuit breaker: tool call limit reached", {
            taskId: task.id,
            toolCalls: task.progress.toolCalls,
            maxToolCalls,
            agent: task.agent,
            sessionID,
          })
          void this.cancelTask(task.id, {
            source: "circuit-breaker",
            reason: `Subagent exceeded maximum tool call limit (${maxToolCalls}). This usually indicates an infinite loop. The task was automatically cancelled to prevent excessive token usage.`,
          })
        }
      }
    }

    if (event.type === "todo.updated") {
      const sessionID = resolveSessionEventID(props)
      const todos = Array.isArray(props?.todos) ? props.todos : undefined
      if (!sessionID || !todos) return

      const hasIncompleteTodos = todos.some((todo) => {
        if (!todo || typeof todo !== "object") return false
        const status = (todo as { status?: unknown }).status
        return status !== "completed" && status !== "cancelled"
      })
      this.observedIncompleteTodosBySession.set(sessionID, hasIncompleteTodos)
      return
    }

    if (event.type === "session.idle") {
      if (!props || typeof props !== "object") return
      handleSessionIdleBackgroundEvent({
        properties: props as Record<string, unknown>,
        findBySession: (id) => {
          const resolved = this.resolveTaskAttemptBySession(id)
          return resolved?.isCurrent ? resolved.task : undefined
        },
        idleDeferralTimers: this.idleDeferralTimers,
        validateSessionHasOutput: (id) => this.validateSessionHasOutput(id),
        checkSessionTodos: (id) => this.checkSessionTodos(id),
        tryCompleteTask: (task, source) => this.tryCompleteTask(task, source),
        emitIdleEvent: (sessionID) => this.handleEvent({ type: "session.idle", properties: { sessionID } }),
      })
    }

    if (event.type === "session.error") {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return

      const resolved = this.resolveTaskAttemptBySession(sessionID)
      if (!resolved?.isCurrent) return

      const { task } = resolved
      if (task.status !== "running") return

      const errorObj = props?.error as { name?: string; message?: string } | undefined
      const errorName = errorObj?.name
      const errorMessage = props ? getSessionErrorMessage(props) : undefined

      const errorInfo = { name: errorName, message: errorMessage }
      void this.handleSessionErrorEvent({
        errorInfo,
        errorMessage,
        errorName,
        task,
      }).catch((error) => {
        log("[background-agent] Error handling session.error event:", {
          error,
          taskId: task.id,
        })
      })
      return
    }

    if (event.type === "session.deleted") {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return
      this.clearSessionOutputObserved(sessionID)
      this.clearSessionTodoObservation(sessionID)

      const tasksToCancel = new Map<string, BackgroundTask>()
      const directTask = this.resolveTaskAttemptBySession(sessionID)
      if (directTask?.isCurrent) {
        tasksToCancel.set(directTask.task.id, directTask.task)
      }
      for (const descendant of this.getAllDescendantTasks(sessionID)) {
        tasksToCancel.set(descendant.id, descendant)
      }


      if (tasksToCancel.size === 0) {
        this.clearTaskHistoryWhenParentTasksGone(sessionID)
        clearSessionAgent(sessionID)
        return
      }

      const parentSessionsToClear = new Set<string>()

      for (const task of tasksToCancel.values()) {
        parentSessionsToClear.add(task.parentSessionId)

        if (task.status === "running" || task.status === "pending") {
          void this.cancelTask(task.id, {
            source: "session.deleted",
            reason: "Session deleted",
          }).catch(err => {
            log("[background-agent] Failed to cancel task on session.deleted:", { taskId: task.id, error: err })
          })
        }
      }

      for (const parentSessionID of parentSessionsToClear) {
        this.clearTaskHistoryWhenParentTasksGone(parentSessionID)
      }

      this.rootDescendantCounts.delete(sessionID)
      clearDelegatedChildSessionBootstrap(sessionID)
      clearSessionAgent(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }

    if (event.type === "session.status") {
      const sessionID = resolveSessionEventID(props)
      const status = props?.status as { type?: string; message?: string } | undefined
      if (!sessionID || !status?.type) return

      if (status.type === "idle") {
        this.handleEvent({ type: "session.idle", properties: { sessionID } })
        return
      }

      if (status.type !== "retry") return

      const resolved = this.resolveTaskAttemptBySession(sessionID)
      if (!resolved?.isCurrent) return

      const { task } = resolved
      if (task.status !== "running") return

      const errorMessage = typeof status.message === "string" ? status.message : undefined
      const errorInfo = { name: "SessionRetry", message: errorMessage }
      void this.tryFallbackRetry(task, errorInfo, "session.status").catch((error) => {
        log("[background-agent] Error handling session.status fallback retry:", {
          error,
          taskId: task.id,
        })
      })
    }
  }

  private async interruptTaskFromAsyncPromptFailure(
    task: BackgroundTask,
    errorMessage: string,
    reason: string,
  ): Promise<void> {
    if (task.currentAttemptID) {
      finalizeAttempt(task, task.currentAttemptID, "interrupt", errorMessage)
    } else {
      task.status = "interrupt"
      task.error = errorMessage
      task.completedAt = new Date()
    }

    if (task.rootSessionId) {
      this.unregisterRootDescendant(task.rootSessionId)
    }
    this.taskHistory.record(task.parentSessionId, {
      id: task.id,
      sessionID: task.sessionId,
      agent: task.agent,
      description: task.description,
      status: "interrupt",
      category: task.category,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    })

    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    const completionTimer = this.completionTimers.get(task.id)
    if (completionTimer) {
      clearTimeout(completionTimer)
      this.completionTimers.delete(task.id)
    }

    const idleTimer = this.idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      this.idleDeferralTimers.delete(task.id)
    }

    this.cleanupPendingByParent(task)
    removeTaskToastTracking(task.id)
    this.scheduleTaskRemoval(task.id)

    this.updateBackgroundTaskMarker(task.parentSessionId)
    await this.notifyParentSession(task).catch(err => {
      log("[background-agent] Failed to notify on async prompt failure:", { taskId: task.id, error: err })
    })

    if (task.sessionId) {
      clearDelegatedChildSessionBootstrap(task.sessionId)
      SessionCategoryRegistry.remove(task.sessionId)
      await this.abortSessionWithLogging(task.sessionId, `${reason} cleanup`)
    }
  }

  private async handleSessionErrorEvent(args: {
    task: BackgroundTask
    errorInfo: { name?: string; message?: string; statusCode?: number }
    errorName: string | undefined
    errorMessage: string | undefined
  }): Promise<void> {
    const { task, errorInfo, errorMessage, errorName } = args

    if (!task.fallbackChain && task.sessionId) {
      const sessionFallbackChain = this.modelFallbackControllerAccessor?.getSessionFallbackChain(task.sessionId)
      if (sessionFallbackChain?.length) {
        task.fallbackChain = sessionFallbackChain
      }
    }

    if (isAgentNotFoundError({ message: errorInfo.message ?? "" })) {
      log("[background-agent] Handling async agent-not-found session.error:", {
        taskId: task.id,
        errorMessage: errorInfo.message?.slice(0, 100),
      })
      await this.interruptTaskFromAsyncPromptFailure(
        task,
        `Agent "${task.agent}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`,
        "agent-not-found session.error",
      )
      return
    }

    if (await this.tryFallbackRetry(task, errorInfo, "session.error")) {
      return
    }

    const errorMsg = errorMessage ?? "Session error"
    const canRetry =
      shouldRetryError(errorInfo) &&
      !!task.fallbackChain &&
      hasMoreFallbacks(task.fallbackChain, task.attemptCount ?? 0)
    log("[background-agent] Session error - no retry:", {
      taskId: task.id,
      errorName,
      errorMessage: errorMsg?.slice(0, 100),
      hasFallbackChain: !!task.fallbackChain,
      canRetry,
    })

    const sessionId = task.sessionId
    if (sessionId) {
      const sessionStillAlive = await this.verifySessionExists(sessionId)
      if (sessionStillAlive && !isTerminalSessionError(errorInfo)) {
        this.logger("[background-agent] session.error received but session still alive, treating as transient:", {
          taskId: task.id,
          sessionId,
          errorMessage: errorMsg?.slice(0, 200),
        })
        return
      }
      if (sessionStillAlive && isTerminalSessionError(errorInfo)) {
        this.logger("[background-agent] Finalizing task after terminal session.error (session shell alive but will never produce output):", {
          taskId: task.id,
          sessionId,
          errorName,
          errorMessage: errorMsg?.slice(0, 200),
        })
      }
    }

    if (task.currentAttemptID) {
      finalizeAttempt(task, task.currentAttemptID, "error", errorMsg)
    } else {
      task.status = "error"
      task.error = errorMsg
      task.completedAt = new Date()
    }
    if (task.rootSessionId) {
      this.unregisterRootDescendant(task.rootSessionId)
    }
    this.taskHistory.record(task.parentSessionId, { id: task.id, sessionID: task.sessionId, agent: task.agent, description: task.description, status: "error", category: task.category, startedAt: task.startedAt, completedAt: task.completedAt })

    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    const completionTimer = this.completionTimers.get(task.id)
    if (completionTimer) {
      clearTimeout(completionTimer)
      this.completionTimers.delete(task.id)
    }

    const idleTimer = this.idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      this.idleDeferralTimers.delete(task.id)
    }

    this.cleanupPendingByParent(task)
    const toastManager = getTaskToastManager()
    if (toastManager) {
      toastManager.removeTask(task.id)
    }
    this.scheduleTaskRemoval(task.id)
    if (task.sessionId) {
      clearDelegatedChildSessionBootstrap(task.sessionId)
      SessionCategoryRegistry.remove(task.sessionId)
    }

    // Update continuation marker for CLI run mode
    if (task.parentSessionId) {
      this.updateBackgroundTaskMarker(task.parentSessionId)
    }

    await this.notifyParentSession(task).catch(err => {
      log("[background-agent] Error in notifyParentSession for errored task:", { taskId: task.id, error: err })
    })
  }

  private async tryFallbackRetry(
    task: BackgroundTask,
    errorInfo: { name?: string; message?: string; statusCode?: number },
    source: string,
  ): Promise<boolean> {
    const previousSessionID = task.sessionId
    const result = tryFallbackRetry({
      task,
      errorInfo,
      source,
      concurrencyManager: this.concurrencyManager,
      client: this.client,
      idleDeferralTimers: this.idleDeferralTimers,
      queuesByKey: this.queuesByKey,
      processKey: (key: string) => this.processKey(key),
    })
    const retried = await result
    if (retried && previousSessionID) {
      this.clearSessionOutputObserved(previousSessionID)
      this.clearSessionTodoObservation(previousSessionID)
      clearDelegatedChildSessionBootstrap(previousSessionID)
      subagentSessions.delete(previousSessionID)
    }
    return retried
  }

  /**
   * Validates that a session has actual assistant/tool output before marking complete.
   * Prevents premature completion when session.idle fires before agent responds.
   */
  private async validateSessionHasOutput(sessionID: string): Promise<boolean> {
    if (this.observedOutputSessions.has(sessionID)) {
      return true
    }

    try {
      const response = await messagesInDirectory(this.client, {
        path: { id: sessionID },
      }, this.directory)

      const messages = normalizeSDKResponse(response, [] as Array<{ info?: { role?: string } }>, { preferResponseOnMissingData: true })

      // Check for at least one assistant or tool message
      const hasAssistantOrToolMessage = messages.some(
        (m: { info?: { role?: string } }) =>
          m.info?.role === "assistant" || m.info?.role === "tool"
      )

      if (!hasAssistantOrToolMessage) {
        log("[background-agent] No assistant/tool messages found in session:", sessionID)
        return false
      }

      // OpenCode API uses different part types than Anthropic's API:
      // - "reasoning" with .text property (thinking/reasoning content)
      // - "tool" with .state.output property (tool call results)
      // - "text" with .text property (final text output)
      // - "step-start"/"step-finish" (metadata, no content)
      type SessionPart = { type?: string; text?: string; content?: string | unknown[] }
      type SessionMessage = { info?: { role?: string }; parts?: SessionPart[] }
      const hasContent = messages.some((m: SessionMessage) => {
        if (m.info?.role !== "assistant" && m.info?.role !== "tool") return false
        const parts = m.parts ?? []
      return parts.some((p: SessionPart) =>
        // Text content (final output)
        (p.type === "text" && p.text && p.text.trim().length > 0) ||
        // Reasoning content (thinking blocks)
        (p.type === "reasoning" && p.text && p.text.trim().length > 0) ||
        // Tool calls (indicates work was done)
        p.type === "tool" ||
        // Tool results (output from executed tools) - important for tool-only tasks
        (p.type === "tool_result" && p.content &&
          (typeof p.content === "string" ? p.content.trim().length > 0 : p.content.length > 0))
      )
      })

      if (!hasContent) {
        log("[background-agent] Messages exist but no content found in session:", sessionID)
        return false
      }

      this.markSessionOutputObserved(sessionID)
      return true
    } catch (error) {
      log("[background-agent] Error validating session output:", error)
      // On error, allow completion to proceed (don't block indefinitely)
      return true
    }
  }

  /**
   * Remove task from pending tracking for its parent session.
   * Cleans up the parent entry if no pending tasks remain.
   */
  private cleanupPendingByParent(task: BackgroundTask): void {
    if (!task.parentSessionId) return
    const pending = this.pendingByParent.get(task.parentSessionId)
    if (pending) {
      pending.delete(task.id)
      if (pending.size === 0) {
        this.pendingByParent.delete(task.parentSessionId)
      }
    }
  }

  private clearTaskHistoryWhenParentTasksGone(parentSessionID: string | undefined): void {
    if (!parentSessionID) return
    if (this.getTasksByParentSession(parentSessionID).length > 0) return
    this.taskHistory.clearSession(parentSessionID)
  }

  private scheduleTaskRemoval(taskId: string, rescheduleCount = 0): void {
    const existingTimer = this.completionTimers.get(taskId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.completionTimers.delete(taskId)
    }

    const timer = setTimeout(() => {
      this.completionTimers.delete(taskId)
      const task = this.tasks.get(taskId)
      if (!task) return

      if (task.parentSessionId) {
        const siblings = this.getTasksByParentSession(task.parentSessionId)
        const runningOrPendingSiblings = siblings.filter(
          sibling => sibling.id !== taskId && (sibling.status === "running" || sibling.status === "pending"),
        )
        const completedAtTimestamp = task.completedAt?.getTime()
        const reachedTaskTtl = completedAtTimestamp !== undefined && (Date.now() - completedAtTimestamp) >= TASK_TTL_MS
        if (runningOrPendingSiblings.length > 0 && rescheduleCount < MAX_TASK_REMOVAL_RESCHEDULES && !reachedTaskTtl) {
          this.scheduleTaskRemoval(taskId, rescheduleCount + 1)
          return
        }
      }

      this.removeTask(task)
      this.clearTaskHistoryWhenParentTasksGone(task.parentSessionId)
      if (task.sessionId) {
        subagentSessions.delete(task.sessionId)
        clearDelegatedChildSessionBootstrap(task.sessionId)
        SessionCategoryRegistry.remove(task.sessionId)
      }
      log("[background-agent] Removed completed task from memory:", taskId)
    }, this.config?.taskCleanupDelayMs ?? TASK_CLEANUP_DELAY_MS)

    this.completionTimers.set(taskId, timer)
  }

  async cancelTask(
    taskId: string,
    options?: { source?: string; reason?: string; abortSession?: boolean; skipNotification?: boolean }
  ): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || (task.status !== "running" && task.status !== "pending")) {
      return false
    }

    const source = options?.source ?? "cancel"
    const abortSession = options?.abortSession !== false
    const reason = options?.reason

    if (task.status === "pending") {
      const rawKey = this.getRawConcurrencyKeyFromTask(task)
      const key = this.concurrencyManager.getConcurrencyKey(rawKey)
      const queue = this.queuesByKey.get(key)
      if (queue) {
        const index = queue.findIndex(item => item.task.id === taskId)
        if (index !== -1) {
          queue.splice(index, 1)
          if (queue.length === 0) {
            this.queuesByKey.delete(key)
          }
        }
      }
      this.rollbackPreStartDescendantReservation(task)
      this.concurrencyManager.cancelWaiter(rawKey, taskId)
      log("[background-agent] Cancelled pending task:", { taskId, key })
    }

    const wasRunning = task.status === "running"
    if (wasRunning && abortSession && task.sessionId) {
      const aborted = await this.abortSessionWithLogging(task.sessionId, `task cancellation (${source})`)
      if (!aborted) return false

      clearDelegatedChildSessionBootstrap(task.sessionId)
      SessionCategoryRegistry.remove(task.sessionId)
    }
    if (task.currentAttemptID) {
      finalizeAttempt(task, task.currentAttemptID, "cancelled", reason)
    } else {
      task.status = "cancelled"
      task.completedAt = new Date()
      if (reason) {
        task.error = reason
      }
    }
    if (wasRunning && task.rootSessionId) {
      this.unregisterRootDescendant(task.rootSessionId)
    }
    this.taskHistory.record(task.parentSessionId, { id: task.id, sessionID: task.sessionId, agent: task.agent, description: task.description, status: "cancelled", category: task.category, startedAt: task.startedAt, completedAt: task.completedAt })

    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    const existingTimer = this.completionTimers.get(task.id)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.completionTimers.delete(task.id)
    }

    const idleTimer = this.idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      this.idleDeferralTimers.delete(task.id)
    }

    removeTaskToastTracking(task.id)

    // Update continuation marker for CLI run mode
    if (task.parentSessionId) {
      this.updateBackgroundTaskMarker(task.parentSessionId)
    }

    if (options?.skipNotification) {
      this.cleanupPendingByParent(task)
      this.scheduleTaskRemoval(task.id)
      log(`[background-agent] Task cancelled via ${source} (notification skipped):`, task.id)
      return true
    }


    try {
      await this.notifyParentSession(task)
      log(`[background-agent] Task cancelled via ${source}:`, task.id)
    } catch (err) {
      log("[background-agent] Error in notifyParentSession for cancelled task:", { taskId: task.id, error: err })
    }

    return true
  }

  /**
   * Cancels a pending task by removing it from queue and marking as cancelled.
   * Does NOT abort session (no session exists yet) or release concurrency slot (wasn't acquired).
   */
  cancelPendingTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "pending") {
      return false
    }

    void this.cancelTask(taskId, { source: "cancelPendingTask", abortSession: false })
    return true
  }

  private startPolling(): void {
    if (this.pollingInterval) return

    this.pollingInterval = setInterval(() => {
      this.pollRunningTasks()
    }, POLLING_INTERVAL_MS)
    this.pollingInterval.unref()
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = undefined
    }
  }

  private registerProcessCleanup(): void {
    registerManagerForCleanup(this)
  }

  private unregisterProcessCleanup(): void {
    unregisterManagerForCleanup(this)
  }

  /**
   * Get all running tasks (for compaction hook)
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === "running")
  }

  /**
   * Get all non-running tasks still in memory (for compaction hook)
   */
  getNonRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status !== "running")
  }

  /**
   * Safely complete a task with race condition protection.
   * Returns true if task was successfully completed, false if already completed by another path.
   */
  private async tryCompleteTask(task: BackgroundTask, source: string): Promise<boolean> {
    if (task.status !== "running") {
      log("[background-agent] Task already completed, skipping:", { taskId: task.id, status: task.status, source })
      return false
    }

    if (task.currentAttemptID) {
      finalizeAttempt(task, task.currentAttemptID, "completed")
    } else {
      task.status = "completed"
      task.completedAt = new Date()
    }
    this.taskHistory.record(task.parentSessionId, { id: task.id, sessionID: task.sessionId, agent: task.agent, description: task.description, status: "completed", category: task.category, startedAt: task.startedAt, completedAt: task.completedAt })

    if (task.rootSessionId) {
      this.unregisterRootDescendant(task.rootSessionId)
    }

    removeTaskToastTracking(task.id)

    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }


    const idleTimer = this.idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      this.idleDeferralTimers.delete(task.id)
    }

    this.updateBackgroundTaskMarker(task.parentSessionId)

    try {
      await this.notifyParentSession(task)
      log(`[background-agent] Task completed via ${source}:`, task.id)
    } catch (err) {
      log("[background-agent] Error in notifyParentSession:", { taskId: task.id, error: err })
    }

    if (task.sessionId) {
      subagentSessions.delete(task.sessionId)
      clearSessionAgent(task.sessionId)
      clearDelegatedChildSessionBootstrap(task.sessionId)
      SessionCategoryRegistry.remove(task.sessionId)

      await this.abortSessionWithLogging(task.sessionId, `task completion (${source})`)

      await this.onSubagentSessionDeleted?.({ sessionID: task.sessionId }).catch((error) => {
        log("[background-agent] onSubagentSessionDeleted callback failed:", { taskId: task.id, sessionID: task.sessionId, error: String(error) })
      })
    }

    return true
  }

  private async notifyParentSession(task: BackgroundTask): Promise<void> {
    const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)

    log("[background-agent] notifyParentSession called for task:", task.id)

    // Show toast notification
    const toastManager = getTaskToastManager()
    if (toastManager) {
      toastManager.showCompletionToast({
        id: task.id,
        description: task.description,
        duration,
      })
    }

    // Update pending tracking and check if all tasks complete
    const pendingSet = this.pendingByParent.get(task.parentSessionId)
    let allComplete = false
    let remainingCount = 0
    if (pendingSet) {
      pendingSet.delete(task.id)
      remainingCount = pendingSet.size
      allComplete = remainingCount === 0
      if (allComplete) {
        this.pendingByParent.delete(task.parentSessionId)
      }
    } else {
      remainingCount = Array.from(this.tasks.values())
        .filter(t => t.parentSessionId === task.parentSessionId && t.id !== task.id && (t.status === "running" || t.status === "pending"))
        .length
      allComplete = remainingCount === 0
    }

    const statusText = task.status === "completed"
      ? "COMPLETED"
      : task.status === "interrupt"
        ? "INTERRUPTED"
        : task.status === "error"
          ? "ERROR"
          : "CANCELLED"
    const notification = buildBackgroundTaskNotificationText({
      task,
      duration,
      statusText,
      allComplete,
      remainingCount,
    })

    if (task.status !== "running" && task.status !== "pending") {
      this.scheduleTaskRemoval(task.id)
    }

    if (this.enableParentSessionNotifications) {
      log("[background-agent] admitting completion notification:", {
        taskId: task.id,
        startsNewTurn: allComplete,
      })

      await notifyBackgroundTaskFinished({
        client: this.client,
        directory: this.directory,
        parentSessionID: task.parentSessionId,
        notification,
        startNewTurn: allComplete,
      })
    } else {
      log("[background-agent] Parent session notifications disabled, skipping prompt injection:", {
        taskId: task.id,
        parentSessionID: task.parentSessionId,
      })
    }

  }

  private hasRunningTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "running") return true
    }
    return false
  }

  private pruneStaleTasks(allStatuses?: SessionStatusMap): void {
    pruneStaleTasks({
      tasks: this.tasks,
      taskTtlMs: this.config?.taskTtlMs,
      sessionStatuses: allStatuses,
      onTaskPruned: (taskId, task, errorMessage) => {
        const wasPending = task.status === "pending"
        log("[background-agent] Pruning stale task:", { taskId, status: task.status, age: Math.round(((wasPending ? task.queuedAt?.getTime() : task.startedAt?.getTime()) ? (Date.now() - (wasPending ? task.queuedAt!.getTime() : task.startedAt!.getTime())) : 0) / 1000) + "s" })
        task.status = "error"
        task.error = errorMessage
        task.completedAt = new Date()
        if (!wasPending && task.rootSessionId) {
          this.unregisterRootDescendant(task.rootSessionId)
        }
        this.taskHistory.record(task.parentSessionId, { id: task.id, sessionID: task.sessionId, agent: task.agent, description: task.description, status: "error", category: task.category, startedAt: task.startedAt, completedAt: task.completedAt })
        if (task.concurrencyKey) {
          this.concurrencyManager.release(task.concurrencyKey)
          task.concurrencyKey = undefined
        }
        removeTaskToastTracking(task.id)
        const existingTimer = this.completionTimers.get(taskId)
        if (existingTimer) {
          clearTimeout(existingTimer)
          this.completionTimers.delete(taskId)
        }
        const idleTimer = this.idleDeferralTimers.get(taskId)
        if (idleTimer) {
          clearTimeout(idleTimer)
          this.idleDeferralTimers.delete(taskId)
        }
        if (wasPending) {
          const key = this.concurrencyManager.getConcurrencyKey(this.getRawConcurrencyKeyFromTask(task))
          const queue = this.queuesByKey.get(key)
          if (queue) {
            const index = queue.findIndex((item) => item.task.id === taskId)
            if (index !== -1) {
              queue.splice(index, 1)
              if (queue.length === 0) {
                this.queuesByKey.delete(key)
              }
            }
          }
        }
        this.cleanupPendingByParent(task)
        // Update continuation marker for CLI run mode
        if (task.parentSessionId) {
          this.updateBackgroundTaskMarker(task.parentSessionId)
        }
        void this.notifyParentSession(task).catch(err => {
          log("[background-agent] Error in notifyParentSession for stale-pruned task:", { taskId: task.id, error: err })
        })
      },
    })
  }

  private async checkAndInterruptStaleTasks(
    allStatuses: SessionStatusMap | undefined,
  ): Promise<void> {
    await checkAndInterruptStaleTasks({
      tasks: this.tasks.values(),
      client: this.client,
      directory: this.directory,
      config: this.config,
      concurrencyManager: this.concurrencyManager,
      notifyParentSession: (task) => this.notifyParentSession(task),
      sessionStatuses: allStatuses,
    })
  }

  private async verifySessionExists(sessionID: string): Promise<boolean> {
    return verifySessionStillExists(this.client, sessionID, this.directory)
  }

  private async failCrashedTask(task: BackgroundTask, errorMessage: string): Promise<void> {
    if (task.currentAttemptID) {
      finalizeAttempt(task, task.currentAttemptID, "error", errorMessage)
    } else {
      task.status = "error"
      task.error = errorMessage
      task.completedAt = new Date()
    }
    if (task.rootSessionId) {
      this.unregisterRootDescendant(task.rootSessionId)
    }
    this.taskHistory.record(task.parentSessionId, { id: task.id, sessionID: task.sessionId, agent: task.agent, description: task.description, status: "error", category: task.category, startedAt: task.startedAt, completedAt: task.completedAt })
    if (task.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    const completionTimer = this.completionTimers.get(task.id)
    if (completionTimer) {
      clearTimeout(completionTimer)
      this.completionTimers.delete(task.id)
    }
    const idleTimer = this.idleDeferralTimers.get(task.id)
    if (idleTimer) {
      clearTimeout(idleTimer)
      this.idleDeferralTimers.delete(task.id)
    }

    this.cleanupPendingByParent(task)
    removeTaskToastTracking(task.id)
    this.scheduleTaskRemoval(task.id)
    if (task.sessionId) {
      clearDelegatedChildSessionBootstrap(task.sessionId)
      SessionCategoryRegistry.remove(task.sessionId)
    }

    // Update continuation marker for CLI run mode
    if (task.parentSessionId) {
      this.updateBackgroundTaskMarker(task.parentSessionId)
    }

    await this.notifyParentSession(task).catch(err => {
      log("[background-agent] Error in notifyParentSession for crashed task:", { taskId: task.id, error: err })
    })
  }

  private async pollRunningTasks(): Promise<void> {
    if (this.pollingInFlight) return
    this.pollingInFlight = true
    try {
      let allStatuses: SessionStatusMap | undefined
      const sessionStatusMethod = this.client?.session?.status
      if (typeof sessionStatusMethod !== "function") {
        if (!this.loggedSessionStatusUnavailable) {
          log("[background-agent] Unable to poll session statuses:", {
            reason: "session.status unavailable",
          })
          this.loggedSessionStatusUnavailable = true
        }
      } else {
        try {
          const statusResult = await this.client.session.status()
          allStatuses = normalizeSDKResponse(statusResult, {})
        } catch (error) {
          if (!this.loggedSessionStatusUnavailable) {
            log("[background-agent] Error polling session statuses:", { error })
            this.loggedSessionStatusUnavailable = true
          }
        }
      }

      this.pruneStaleTasks(allStatuses)

      await this.checkAndInterruptStaleTasks(allStatuses)

      for (const task of this.tasks.values()) {
        if (task.status !== "running") continue

        const sessionID = task.sessionId
        if (!sessionID) continue

        try {
          const sessionStatus = allStatuses?.[sessionID]
          // Handle retry before checking running state
          if (sessionStatus?.type === "retry") {
            const retryMessage = typeof (sessionStatus as { message?: string }).message === "string"
              ? (sessionStatus as { message?: string }).message
              : undefined
            const errorInfo = { name: "SessionRetry", message: retryMessage }
            if (await this.tryFallbackRetry(task, errorInfo, "polling:session.status")) {
              continue
            }
          }

          // Only skip completion when session status is actively running.
          // Unknown or terminal statuses (like "interrupted") fall through to completion.
          if (sessionStatus && isActiveSessionStatus(sessionStatus.type)) {
            log("[background-agent] Session still running, relying on event-based progress:", {
              taskId: task.id,
              sessionID,
              sessionStatus: sessionStatus.type,
              toolCalls: task.progress?.toolCalls ?? 0,
            })
            continue
          }

          if (sessionStatus && isTerminalSessionStatus(sessionStatus.type)) {
            await this.tryCompleteTask(task, `polling (terminal session status: ${sessionStatus.type})`)
            continue
          }

          if (sessionStatus && sessionStatus.type !== "idle") {
            log("[background-agent] Unknown session status, treating as potentially idle:", {
              taskId: task.id,
              sessionID,
              sessionStatus: sessionStatus.type,
            })
          }

          if (allStatuses === undefined) {
            continue
          }

          // Session is idle or no longer in status response (completed/disappeared)
          const sessionGoneFromStatus = allStatuses !== undefined && !sessionStatus
          const sessionGoneThresholdReached = sessionGoneFromStatus
            && (task.consecutiveMissedPolls ?? 0) >= MIN_SESSION_GONE_POLLS
          const completionSource = sessionStatus?.type === "idle"
            ? "polling (idle status)"
            : "polling (session gone from status)"
          const hasValidOutput = await this.validateSessionHasOutput(sessionID)
          if (!hasValidOutput) {
            if (sessionGoneThresholdReached) {
              const sessionExists = await this.verifySessionExists(sessionID)
              if (!sessionExists) {
                log("[background-agent] Session no longer exists (crashed), marking task as error:", task.id)
                await this.failCrashedTask(task, "Subagent session no longer exists (process likely crashed). The session disappeared without producing any output.")
                continue
              }

              task.consecutiveMissedPolls = 0
            }
            log("[background-agent] Polling idle/gone but no valid output yet, waiting:", task.id)
            continue
          }

          // Re-check status after async operation
          if (task.status !== "running") continue

          const hasIncompleteTodos = await this.checkSessionTodos(sessionID)
          if (hasIncompleteTodos) {
            log("[background-agent] Task has incomplete todos via polling, waiting:", task.id)
            continue
          }

          await this.tryCompleteTask(task, completionSource)
        } catch (error) {
          log("[background-agent] Poll error for task:", { taskId: task.id, error })
        }
      }

      if (!this.hasRunningTasks()) {
        this.stopPolling()
      }
    } finally {
      this.pollingInFlight = false
    }
  }

  /**
   * Shutdown the manager gracefully.
   * Cancels all pending concurrency waiters and clears timers.
   * Should be called when the plugin is unloaded.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownTriggered) return
    this.shutdownTriggered = true
    log("[background-agent] Shutting down BackgroundManager")
    this.stopPolling()
    const trackedSessionIDs = new Set<string>()
    const abortRequests: Array<{ sessionID: string; promise: Promise<unknown> }> = []

    // Abort all running sessions to prevent zombie processes (#1240)
    for (const task of this.tasks.values()) {
      if (task.sessionId) {
        trackedSessionIDs.add(task.sessionId)
      }

      if (task.status === "running" && task.sessionId) {
        abortRequests.push({
          sessionID: task.sessionId,
          promise: abortWithTimeout(this.client, task.sessionId),
        })
      }
    }

    if (abortRequests.length > 0) {
      const abortResults = await Promise.allSettled(abortRequests.map((request) => request.promise))
      for (const [index, abortResult] of abortResults.entries()) {
        if (abortResult.status === "fulfilled") continue

        log("[background-agent] Error aborting session during shutdown:", {
          error: abortResult.reason,
          sessionID: abortRequests[index]?.sessionID,
        })
      }
    }

    // Notify shutdown listeners (e.g., tmux cleanup)
    if (this.onShutdown) {
      try {
        await this.onShutdown()
      } catch (error) {
        log("[background-agent] Error in onShutdown callback:", error)
      }
    }

    // Release concurrency for all running tasks
    for (const task of this.tasks.values()) {
      if (TERMINAL_BACKGROUND_TASK_STATUSES.has(task.status)) {
        archiveBackgroundTask(task)
      } else {
        forgetBackgroundTask(task.id)
      }

      if (task.concurrencyKey) {
        this.concurrencyManager.release(task.concurrencyKey)
        task.concurrencyKey = undefined
      }
    }

    for (const timer of this.completionTimers.values()) {
      clearTimeout(timer)
    }
    this.completionTimers.clear()

    for (const timer of this.idleDeferralTimers.values()) {
      clearTimeout(timer)
    }
    this.idleDeferralTimers.clear()

    for (const sessionID of trackedSessionIDs) {
      subagentSessions.delete(sessionID)
      clearDelegatedChildSessionBootstrap(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }

    this.concurrencyManager.clear()
    this.tasks.clear()
    this.tasksByParentSession.clear()
    this.pendingByParent.clear()
    this.rootDescendantCounts.clear()
    this.queuesByKey.clear()
    this.processingKeys.clear()
    this.taskHistory.clearAll()
    this.unregisterProcessCleanup()
    log("[background-agent] Shutdown complete")

  }
}
