import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../../shared/agent-status-hooks-setting'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../shared/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  getPtyIdForPaneKey,
  hookLaneCanAnnouncePaneTurnEnd
} from './agent-hook-completion-notifications'

// Why: a paired server (incl. SSH) that predates the turn-end stamp can't tell a Stop re-entered
// after a blocking Stop hook from a restatement, so its panes keep the title fallback. Local and
// WSL-relay panes always run this build.
function paneHostStampsTurnEnds(paneKey: string): boolean {
  const ptyId = getPtyIdForPaneKey(paneKey)
  if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
    return true
  }
  const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
  const entry = environmentId
    ? useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
    : undefined
  return (
    lastVerifiedRuntimeStatus(entry)?.capabilities?.includes(
      AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY
    ) === true
  )
}

/**
 * Whether this pane's turn ends are announced by its hook lane. A title idle edge on such a pane
 * (Claude's /btw, Codex's /compact) ended no hook turn, so it must not announce one.
 */
export function hookLaneOwnsPaneTurnEnds(paneKey: string, title: string): boolean {
  const { agentStatusByPaneKey, settings } = useAppStore.getState()
  const row = agentStatusByPaneKey[paneKey]
  const agent = row?.agentType
  // Why: the title lane stays the fallback for an unfinished turn, and once the agent's hooks are
  // switched off (they are uninstalled, so the hook lane never hears another turn end).
  const hooksInstalled = isTuiAgent(agent)
    ? isAgentStatusHooksEnabledForAgent(settings, agent)
    : isAgentStatusHooksEnabled(settings)
  if (
    row?.state !== 'done' ||
    !hooksInstalled ||
    !hookLaneCanAnnouncePaneTurnEnd(paneKey) ||
    !paneHostStampsTurnEnds(paneKey)
  ) {
    return false
  }
  const titleAgentType = resolveCommittedTitleAgentType(title)
  return (
    !titleAgentType ||
    !agent ||
    agent === 'unknown' ||
    resolveCompatibleAgentTypeForOwner(agent, titleAgentType) === titleAgentType
  )
}
