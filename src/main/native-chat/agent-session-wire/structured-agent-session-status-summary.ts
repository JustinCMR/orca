import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  journal,
  record,
  state,
  stopping,
  childWork,
  now
}: {
  sessionId: string
  session: {
    params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
    child?: Pick<StructuredAgentSessionProviderChild, 'phase'> | null
    restartResume?: AgentSessionStatusSummary['restartResume']
  }
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  state: StructuredAgentSessionStatusState
  /** A person's Stop is still ending the work it stopped. */
  stopping: boolean
  childWork: Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'>
  now: () => number
}): AgentSessionStatusSummary {
  const projected = state.summary
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  const permissionMode = record?.permissionMode
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  return {
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider,
    ...(session.child
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: session.child.phase
        }
      : {}),
    ...(session.restartResume ? { restartResume: { phase: session.restartResume.phase } } : {}),
    ...projected,
    // Only a working session is still being stopped; any other status already ended that work.
    ...(stopping && projected.status === 'working' ? { stopping: true as const } : {}),
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(isAgentChatPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...childWork,
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...structuredAgentSessionRecordNotes(record),
    updatedAt: journal.lastActivityAt() || now()
  }
}

/** What the row reads from the record alone; a closed chat's retained summary re-reads it too. */
function structuredAgentSessionRecordNotes(
  record: AgentSessionRecord | null
): Pick<AgentSessionStatusSummary, 'conversationName' | 'sleptAt'> {
  return {
    ...(record?.conversationName ? { conversationName: record.conversationName } : {}),
    ...(typeof record?.sleptAt === 'number' ? { sleptAt: record.sleptAt } : {})
  }
}

/** A retained summary re-read from its record; null when there is none or nothing it shows moved. */
export function withRecordNotes(
  summary: AgentSessionStatusSummary | undefined,
  record: AgentSessionRecord | null
): AgentSessionStatusSummary | null {
  if (!summary) {
    return null
  }
  const { conversationName: _name, sleptAt: _sleptAt, ...rest } = summary
  const next = { ...rest, ...structuredAgentSessionRecordNotes(record) }
  return next.conversationName === summary.conversationName && next.sleptAt === summary.sleptAt
    ? null
    : next
}
