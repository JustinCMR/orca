import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isAgentStatusHooksEnabled } from '../../../shared/agent-status-hooks-setting'
import { hookLaneTracksPaneTurns } from './agent-hook-completion-notifications'

/**
 * Whether this pane's turn ends are announced by its hook lane. A title idle edge on such a pane
 * (Claude's /btw, Codex's /compact) ended no hook turn, so it must not announce one.
 */
export function hookLaneOwnsPaneTurnEnds(paneKey: string, title: string): boolean {
  const state = useAppStore.getState()
  const row = state.agentStatusByPaneKey[paneKey]
  // Why: the title lane stays the fallback wherever the hook lane cannot announce: no hooks seen,
  // re-arming after a restart, hooks switched off, a restored row, or an unfinished turn.
  if (
    !hookLaneTracksPaneTurns(paneKey) ||
    !isAgentStatusHooksEnabled(state.settings) ||
    row?.state !== 'done' ||
    row.restoredUnconfirmed === true
  ) {
    return false
  }
  const titleAgentType = resolveCommittedTitleAgentType(title)
  return (
    !titleAgentType ||
    !row.agentType ||
    row.agentType === 'unknown' ||
    resolveCompatibleAgentTypeForOwner(row.agentType, titleAgentType) === titleAgentType
  )
}
