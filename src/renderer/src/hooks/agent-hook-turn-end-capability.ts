import { useAppStore } from '@/store'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../shared/remote-runtime-pty-id'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { agentReportsStopHookContinuation } from '../../../shared/agent-stop-hook-continuation'

// Why: a paired server (incl. SSH) that predates the turn-end stamp can't tell a later turn end
// from a restatement. Local and WSL-relay PTYs always run this build; an unbound PTY is unknown.
function ptyHostStampsTurnEnds(ptyId: string | null | undefined): boolean {
  if (!ptyId) {
    return false
  }
  if (!isRemoteRuntimePtyId(ptyId)) {
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
 * The one gate for every pane behavior that hook-owned turn ends changed: the pane's bound PTY
 * runs on a host that stamps turn ends, and its agent's continuation signal is verified. Every
 * other pane keeps main's title-lane behavior exactly.
 */
export function paneUsesHookTurnEnds(
  ptyId: string | null | undefined,
  agentType: string | null | undefined
): boolean {
  return agentReportsStopHookContinuation(agentType) && ptyHostStampsTurnEnds(ptyId)
}
