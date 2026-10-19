import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-status-hooks-setting'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { hookLaneCanAnnouncePaneTurnEnd } from './agent-hook-completion-notifications'
import { paneUsesHookTurnEnds } from './agent-hook-turn-end-capability'

/**
 * Whether this pane's turn ends are announced by its hook lane, for a title or process that names
 * `agent` (null: names none). A title spin (Claude's /btw, Codex's /compact) or quitting the agent
 * after its last turn ended ends no hook turn, so it must not announce one.
 */
export function hookLaneOwnsAgentTurnEnds(
  paneKey: string,
  ptyId: string | null | undefined,
  agent: TerminalAgent | null
): boolean {
  const { agentStatusByPaneKey, settings } = useAppStore.getState()
  const row = agentStatusByPaneKey[paneKey]
  const owner = row?.agentType
  // Why: the title lane stays the fallback for an unfinished turn, and once the agent's hooks are
  // switched off (they are uninstalled, so the hook lane never hears another turn end).
  if (
    row?.state !== 'done' ||
    !isTuiAgent(owner) ||
    !paneUsesHookTurnEnds(ptyId, owner) ||
    !isAgentStatusHooksEnabledForAgent(settings, owner) ||
    !hookLaneCanAnnouncePaneTurnEnd(paneKey)
  ) {
    return false
  }
  return !agent || resolveCompatibleAgentTypeForOwner(owner, agent) === agent
}

export function hookLaneOwnsTitleTurnEnds(
  paneKey: string,
  ptyId: string | null | undefined,
  title: string
): boolean {
  return hookLaneOwnsAgentTurnEnds(paneKey, ptyId, resolveCommittedTitleAgentType(title))
}
