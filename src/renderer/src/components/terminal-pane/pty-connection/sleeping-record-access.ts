import { useAppStore } from '@/store'
import { selectSleepingRecordForPane } from '@/lib/sleeping-pane-record-selection'
import type { ColdRestoreAgentResumeStartup, PaneRestoreOutcome } from './fresh-spawn-types'
import type { PtyConnectResult } from '../pty-transport-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { neutralTerminalTitle } from '../../../../../shared/terminal-pane-title-reset'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { recognizeAgentProcessFromCommandLine } from '../../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
import {
  beginAgentStartupDeliveryAttempt,
  releaseAgentStartupDeliveryAttempt
} from '@/lib/agent-startup-delayed-delivery'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installCommandInferredPaneAgent } from './command-inferred-pane-agent'

export function installSleepingRecordAccess(session: ConnectPanePtySession): void {
  const selection = {
    paneKey: session.cacheKey,
    tabId: session.deps.tabId,
    paneId: session.pane.id,
    worktreeId: session.deps.worktreeId
  }
  session.getSleepingRecordForPane = (state: ReturnType<typeof useAppStore.getState>) => {
    const selected = selectSleepingRecordForPane(state.sleepingAgentSessionsByPaneKey, selection)
    return selected === 'ambiguous' ? null : selected
  }
  session.clearSleepingRecordProviderDuplicates = (
    state: ReturnType<typeof useAppStore.getState>,
    consumed: { paneKey: string; record: SleepingAgentSessionRecord },
    wake?: true
  ) =>
    state.clearSleepingAgentSession(consumed.paneKey, {
      ...selection,
      record: consumed.record,
      wake
    })
  const ownsRecord = (startup: ColdRestoreAgentResumeStartup): boolean => {
    const selected = selectSleepingRecordForPane(
      useAppStore.getState().sleepingAgentSessionsByPaneKey,
      selection
    )
    return Boolean(
      selected &&
      selected !== 'ambiguous' &&
      startup.sleepingRecordEntry &&
      getProviderSessionClaimKey(selected.record) ===
        getProviderSessionClaimKey(startup.sleepingRecordEntry.record)
    )
  }
  session.acceptPaneRestore = (
    outcome: Extract<PaneRestoreOutcome, { kind: 'connected' }>,
    startup: ColdRestoreAgentResumeStartup | null | undefined,
    resumeUnavailable = false
  ): PaneRestoreOutcome => {
    if (outcome.generation !== session.transportStreamGeneration) {
      return { kind: 'superseded', generation: outcome.generation }
    }
    const entry = startup && !startup.useLiveEntry ? startup.sleepingRecordEntry : null
    if (entry) {
      const disposition = session.clearSleepingRecordProviderDuplicates(
        useAppStore.getState(),
        entry,
        true
      )
      if (disposition === 'superseded') {
        return { kind: 'superseded', generation: outcome.generation, ptyId: outcome.ptyId }
      }
      outcome = { ...outcome, recordAcceptance: disposition }
    }
    if (resumeUnavailable) {
      session.showSessionRestoredBanner('resume-unavailable')
    } else if (outcome.recordAcceptance === 'accepted') {
      session.showSessionRestoredBanner()
    }
    return outcome
  }
  session.launchToken = session.paneStartup?.launchConfig
    ? (session.paneStartup.launchToken ?? createBrowserUuid())
    : undefined
  session.startupDraftAgent =
    session.paneStartup?.launchAgent ?? session.paneStartup?.initialAgentStatus?.agent
  session.startupDraftAgentConfig = session.startupDraftAgent
    ? TUI_AGENT_CONFIG[session.startupDraftAgent]
    : null
  session.startupDraftPrompt =
    typeof session.paneStartup?.draftPrompt === 'string' && session.paneStartup.draftPrompt.trim()
      ? session.paneStartup.draftPrompt
      : null
  session.startupDraftPromptNeedsPaste =
    session.startupDraftPrompt !== null &&
    !session.startupDraftAgentConfig?.draftPromptFlag &&
    !session.startupDraftAgentConfig?.draftPromptEnvVar
  session.startupDraftDeliveryClaimed = false
  session.startupDraftPasteAttempted = false
  session.claimStartupDraftPasteDelivery = (): boolean => {
    if (!session.startupDraftPromptNeedsPaste || session.launchToken === undefined) {
      return false
    }
    if (session.startupDraftDeliveryClaimed) {
      return true
    }
    // Why: launch-bound draft paste needs a launch token; all current
    // draftPrompt startup callers pair it with launchConfig so this can safely
    // fence off delayed sidecar delivery before Codex's first composer frame.
    session.startupDraftDeliveryClaimed = beginAgentStartupDeliveryAttempt({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      launchToken: session.launchToken
    })
    return session.startupDraftDeliveryClaimed
  }
  session.releaseUnattemptedStartupDraftPasteDelivery = (): void => {
    if (
      !session.startupDraftDeliveryClaimed ||
      session.startupDraftPasteAttempted ||
      session.launchToken === undefined
    ) {
      return
    }
    releaseAgentStartupDeliveryAttempt({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      launchToken: session.launchToken
    })
    session.startupDraftDeliveryClaimed = false
  }
  // Why: reserve before deferred connect so the creation sidecar cannot time out during setup and strand this pane's live scanner.
  session.ownsStartupDraftPaste = session.claimStartupDraftPasteDelivery()
  if (session.paneStartup?.launchConfig) {
    useAppStore
      .getState()
      .registerAgentLaunchConfig(session.cacheKey, session.paneStartup.launchConfig, {
        agentType: session.paneStartup.launchAgent ?? session.paneStartup.initialAgentStatus?.agent,
        ...(session.launchToken ? { launchToken: session.launchToken } : {}),
        tabId: session.deps.tabId,
        leafId: session.pane.leafId
      })
  } else if (session.paneStartup) {
    useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
  }
  session.registerEffectiveLaunchConfig = (
    effectiveLaunchConfig: PtyConnectResult['launchConfig'] | undefined,
    metadata?: { launchToken?: string; launchAgent?: TuiAgent },
    startup?: ColdRestoreAgentResumeStartup | null
  ): void => {
    if (startup?.sleepingRecordEntry && !startup.useLiveEntry && !ownsRecord(startup)) {
      return
    }
    if (!effectiveLaunchConfig) {
      if (metadata?.launchAgent) {
        // Why: daemon launch identity can outlive the process while Orca is
        // closed. Use it to request confirmation, never as current byte authority.
        const state = useAppStore.getState()
        const current = state.paneForegroundAgentByPaneKey[session.cacheKey]
        // Why: re-mounting a parked pane must not demote this session's own read of the same agent.
        const keepsRead =
          current?.agent === metadata.launchAgent && current.agentEvidence === 'process-read'
        state.setPaneForegroundAgent(session.cacheKey, {
          agent: metadata.launchAgent,
          agentEvidence: keepsRead ? 'process-read' : 'launch-record',
          shellForeground: false
        })
      }
      return
    }
    // Why: daemon reattach preserves the pane's exact launch command but not
    // renderer metadata; recover only allowlisted command identity from it.
    const persistedLaunchAgent = recognizeAgentProcessFromCommandLine(
      effectiveLaunchConfig.agentCommand
    )?.agent
    useAppStore.getState().registerAgentLaunchConfig(session.cacheKey, effectiveLaunchConfig, {
      agentType:
        metadata?.launchAgent ??
        session.paneStartup?.launchAgent ??
        session.paneStartup?.initialAgentStatus?.agent ??
        persistedLaunchAgent,
      ...((metadata?.launchToken ?? session.launchToken)
        ? { launchToken: metadata?.launchToken ?? session.launchToken }
        : {}),
      tabId: session.deps.tabId,
      leafId: session.pane.leafId
    })
  }
  session.clearRegisteredStartupLaunchConfig = (
    startup?: ColdRestoreAgentResumeStartup | null
  ): void => {
    if (startup?.sleepingRecordEntry && !startup.useLiveEntry) {
      const state = useAppStore.getState()
      const selected = selectSleepingRecordForPane(state.sleepingAgentSessionsByPaneKey, selection)
      if (
        (selected !== null && !ownsRecord(startup)) ||
        state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.launchToken !==
          startup.launchToken
      ) {
        return
      }
    }
    useAppStore.getState().clearAgentLaunchConfig(session.cacheKey)
  }
  session.neutralTerminalTitle = (): string => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (entry) => entry.id === session.deps.tabId
    )
    return neutralTerminalTitle(tab?.defaultTitle)
  }
  installCommandInferredPaneAgent(session)
}
