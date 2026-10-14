import {
  resolveTerminalNotificationOwner,
  type TerminalNotificationBinding
} from '@/attention/notification-subject-owner'
import {
  notificationExecutionHostForOwner,
  notificationSourceForOwner
} from '../../../../shared/notification-source'
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import { shareCompatibleTitleIdentityGroup } from '../../../../shared/agent-title-owner'
import {
  agentStatusAuthorityObservedAt,
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { isSupersededAgentCompletionSnapshot } from './agent-completion-snapshot-staleness'
import type {
  AgentCompletionDispatchMeta,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import { getNotificationWorkspaceLabels } from './terminal-notification-state'
import { createTerminalAttentionSurface } from './terminal-attention-surface'
import {
  applyAgentAttention,
  resolveAgentAttention,
  type AgentAttentionDeliveryRequest
} from '@/attention/agent-attention-policy'
import {
  deliverAgentAttentionNotification,
  readAgentAttentionNotificationSound
} from '@/attention/agent-attention-notification-delivery'

// Why: the hook row each pane's last completion already announced, on the authority's own clock
// so host clock skew and relay restamps cannot make an announced turn look new.
const announcedHookEvidenceByPaneKey = new Map<string, number>()

export function resetAnnouncedHookEvidenceForTest(): void {
  announcedHookEvidenceByPaneKey.clear()
}

function announceHookEvidence(
  paneKey: string,
  row: AgentStatusEntry,
  rows: Record<string, AgentStatusEntry>
): void {
  for (const key of announcedHookEvidenceByPaneKey.keys()) {
    if (!rows[key]) {
      announcedHookEvidenceByPaneKey.delete(key)
    }
  }
  announcedHookEvidenceByPaneKey.set(paneKey, agentStatusAuthorityObservedAt(row))
}

function agentSnapshotMatchesExplicitTitle(
  snapshot: { agentType?: string | null } | undefined,
  explicitTitleAgentType: string | null
): boolean {
  return !snapshot || !explicitTitleAgentType || snapshot.agentType === explicitTitleAgentType
}

function hasFreshActiveHookStatus(
  snapshot: Pick<AgentStatusEntry, 'state' | 'updatedAt' | 'agentType'> | undefined,
  explicitTitleAgentType: string | null
): boolean {
  // Why: pick-a-winner ownership would treat a Pi idle title as a different
  // agent than a live OMP hook. Same-group titles are wrapper frames, not reuse.
  const titleNamesDifferentKnownAgent =
    explicitTitleAgentType &&
    snapshot?.agentType &&
    snapshot.agentType !== 'unknown' &&
    !shareCompatibleTitleIdentityGroup(snapshot.agentType, explicitTitleAgentType)
  return Boolean(isFreshNonDoneAgentStatus(snapshot) && !titleNamesDifferentKnownAgent)
}

export type TerminalNotificationEvent = TerminalNotificationBinding & {
  source: 'terminal-bell' | 'agent-task-complete'
  terminalTitle?: string
  agentStatusSnapshot?: AgentCompletionStatusSnapshot
  agentCompletionSource?: AgentCompletionDispatchMeta['source']
}

/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function dispatchTerminalNotification(
  worktreeId: string,
  event: TerminalNotificationEvent
): void {
  const state = useAppStore.getState()
  // Why: the completion title is the live identity. If it explicitly names an
  // agent, any snapshot from another agent is stale pane-reuse residue and must
  // not lend its prompt/agentType or timing id to this notification.
  const explicitTitleAgentType =
    event.source === 'agent-task-complete' && event.terminalTitle
      ? resolveCommittedTitleAgentType(event.terminalTitle)
      : null
  const storedAgentStatus =
    event.source === 'agent-task-complete' && event.paneKey
      ? state.agentStatusByPaneKey[event.paneKey]
      : undefined
  const eventAgentStatusSnapshot =
    event.source === 'agent-task-complete' &&
    agentSnapshotMatchesExplicitTitle(event.agentStatusSnapshot, explicitTitleAgentType)
      ? event.agentStatusSnapshot
      : undefined
  // Why: a settled row of this pane's agent is the hook status of its latest turn end, however
  // long ago it landed; whether that turn is new is judged by announcement, not by age.
  const settledStoredAgentStatus =
    storedAgentStatus &&
    storedAgentStatus.state !== 'working' &&
    storedAgentStatus.restoredUnconfirmed !== true &&
    agentSnapshotMatchesExplicitTitle(storedAgentStatus, explicitTitleAgentType)
      ? storedAgentStatus
      : undefined
  const unannouncedStoredAgentStatus =
    settledStoredAgentStatus &&
    announcedHookEvidenceByPaneKey.get(event.paneKey ?? '') !==
      agentStatusAuthorityObservedAt(settledStoredAgentStatus)
      ? settledStoredAgentStatus
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    event.agentCompletionSource !== 'process-exit' &&
    !eventAgentStatusSnapshot &&
    hasFreshActiveHookStatus(storedAgentStatus, explicitTitleAgentType)
  ) {
    // Why: a title-only idle signal can race behind active hook state; a
    // confirmed process exit is independent authority that the turn ended.
    return
  }
  if (
    event.source === 'agent-task-complete' &&
    event.agentCompletionSource !== 'process-exit' &&
    !eventAgentStatusSnapshot &&
    settledStoredAgentStatus &&
    !unannouncedStoredAgentStatus
  ) {
    // Why: on a hook-reporting pane hooks own turn ends; a title edge with no new hook status since
    // the last completion ended no turn (Claude's /btw side question spins the title, fires no hook).
    return
  }
  // Why: a process can die before its hook emits done; do not label the
  // resulting completion notification with that stale active state or prompt.
  const agentStatus =
    event.source === 'agent-task-complete'
      ? (eventAgentStatusSnapshot ??
        (event.agentCompletionSource === 'process-exit' &&
        unannouncedStoredAgentStatus?.state !== 'done'
          ? undefined
          : unannouncedStoredAgentStatus))
      : undefined
  if (
    event.source === 'agent-task-complete' &&
    isSupersededAgentCompletionSnapshot(storedAgentStatus, eventAgentStatusSnapshot)
  ) {
    return
  }
  if (event.source === 'agent-task-complete' && event.paneKey && settledStoredAgentStatus) {
    announceHookEvidence(event.paneKey, settledStoredAgentStatus, state.agentStatusByPaneKey)
  }
  const agentNotificationStateStartedAt =
    eventAgentStatusSnapshot?.stateStartedAt ?? unannouncedStoredAgentStatus?.stateStartedAt
  const attentionDecision = resolveAgentAttention(
    {
      subject: { workspaceId: worktreeId, surfaceKey: event.paneKey },
      reason: event.source === 'agent-task-complete' ? 'agent-completion' : 'terminal-bell',
      settlesTurn: event.source === 'agent-task-complete',
      // Why: main-process hook IPC can update inactive worktrees before the renderer's live-PTY
      // map catches up. An accepted fresh hook snapshot is authority that the turn ended;
      // title/BEL-only paths still need surface liveness.
      hasFreshActivityEvidence: Boolean(agentStatus)
    },
    createTerminalAttentionSurface(state)
  )
  if (!attentionDecision.admitted) {
    return
  }

  // Desktop settings are applied in main after independent mobile delivery.

  const sound = readAgentAttentionNotificationSound(state.settings ?? {})
  // Why: pane keys are reused across turns. A rich OS notification must not
  // expose the previous turn's prompt if the current turn has no fresh hook snapshot yet.
  const agentSnapshot = agentStatus
    ? {
        agentType: agentStatus.agentType,
        agentState: agentStatus.state,
        agentPrompt: agentStatus.prompt,
        agentToolName: agentStatus.toolName,
        agentToolInput: agentStatus.toolInput,
        agentLastAssistantMessage: agentStatus.lastAssistantMessage,
        agentTurnOutcome: agentMainAgentVerdict(agentStatus) ?? undefined
      }
    : {}
  const notificationId =
    event.source === 'agent-task-complete'
      ? buildAgentNotificationId({
          worktreeId,
          paneKey: event.paneKey,
          // Why: delayed hook completions may dispatch after PTY teardown has
          // removed the live row; carry the hook timing so the OS notification
          // still has the same dismissible id as the unread agent event.
          stateStartedAt: agentNotificationStateStartedAt
        })
      : null

  const requestDelivery = (request: AgentAttentionDeliveryRequest): void => {
    const owner = resolveTerminalNotificationOwner(state, worktreeId, event)
    const executionHost = notificationExecutionHostForOwner(owner)
    deliverAgentAttentionNotification(
      {
        source: event.source,
        ...(notificationId ? { notificationId } : {}),
        worktreeId: request.workspaceId,
        ...(executionHost ? { executionHost } : {}),
        paneKey: request.subjectKey ?? undefined,
        ...getNotificationWorkspaceLabels(state, request.workspaceId, event.terminalTitle),
        notificationSourceId: notificationSourceForOwner(owner, state),
        terminalTitle: event.terminalTitle,
        isActiveWorktree: request.workspaceIsActive,
        ...agentSnapshot
      },
      sound
    )
  }

  applyAgentAttention(attentionDecision, {
    unread: state.markAgentAttentionUnread,
    requestDelivery
  })
}

export function useNotificationDispatch(
  worktreeId: string
): (event: TerminalNotificationEvent) => void {
  return useCallback(
    (event: TerminalNotificationEvent) => dispatchTerminalNotification(worktreeId, event),
    [worktreeId]
  )
}
