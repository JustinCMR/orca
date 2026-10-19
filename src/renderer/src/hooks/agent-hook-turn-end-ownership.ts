import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../../shared/agent-status-hooks-setting'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { hookLaneCanAnnouncePaneTurnEnd } from './agent-hook-completion-notifications'

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
  if (row?.state !== 'done' || !hooksInstalled || !hookLaneCanAnnouncePaneTurnEnd(paneKey)) {
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
