import type { AgentHookEventPayload, HostTurnRecord } from './agent-hook-listener/listener-event'
import { isNewTurnEvent, isTurnEndEvent } from './agent-hook-listener/provider-event-routing'
import { readString } from './agent-hook-listener/tool-input-preview'
import type { AgentHookSource } from './agent-hook-relay'
import { agentReportsStopHookContinuation } from './agent-stop-hook-continuation'

type TurnEndTimingRow = Pick<AgentHookEventPayload, 'turnEndedAt' | 'payload' | 'hostTurn'>

type HostTurnEnd = { turnEndedAt?: number; hostTurn?: HostTurnRecord }

/** The hook body's turn facts the host folds into its turn record; in-process only. */
export function readHostTurnSignals(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  promptInteractionKey: string | undefined
): Pick<AgentHookEventPayload, 'stopHookActive' | 'nativeTurnKey'> {
  // Why: the agent's own turn id tells a new turn from a re-delivery even when no prompt hook
  // ran (Codex turns woken by agent mail, every Command Code turn).
  const nativeTurnKey =
    source === 'codex'
      ? readString(hookPayload, 'turn_id')
      : source === 'command-code'
        ? promptInteractionKey
        : undefined
  return {
    ...(hookPayload.stop_hook_active === true && agentReportsStopHookContinuation(source)
      ? { stopHookActive: true }
      : {}),
    ...(nativeTurnKey ? { nativeTurnKey } : {})
  }
}

export function isTurnEndedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function resolveOwner(
  previous: HostTurnRecord | undefined,
  event: AgentHookEventPayload & { source: NonNullable<AgentHookEventPayload['source']> }
): { owner: string; replaced: boolean } {
  const anonymous = `${event.source}:`
  const sessionId = event.providerSession?.id
  if (!sessionId) {
    // Why: an event that names no session belongs to whichever session of this agent is current.
    return previous?.owner.startsWith(anonymous)
      ? { owner: previous.owner, replaced: false }
      : { owner: anonymous, replaced: previous !== undefined }
  }
  const owner = `${anonymous}${sessionId}`
  return {
    owner,
    replaced: previous !== undefined && previous.owner !== owner && previous.owner !== anonymous
  }
}

/**
 * The one turn-end derivation every execution host runs (local main and the WSL relay). A turn
 * advances on the agent's native turn key (Codex `turn_id`, Command Code's transcript position)
 * or, without one, only on a prompt-opening event. A live root turn-end event mints a new end when
 * its turn differs from the last ended one, or when a verified continuation re-entered after a
 * blocking Stop hook; every restatement (duplicate, replay, idle reminder, tool reopen, result
 * retry) carries the old end. Keys are opaque: only compared for equality.
 */
export function reduceHostTurnEnd(
  previous: TurnEndTimingRow | undefined,
  event: AgentHookEventPayload,
  at: number,
  canMint: boolean
): HostTurnEnd {
  const carried =
    previous?.payload.state === 'done' && isTurnEndedAt(previous.turnEndedAt)
      ? previous.turnEndedAt
      : undefined
  // Why: a relay or a result retry already decided this event's end; the host restates its answer.
  if (!canMint || isTurnEndedAt(event.turnEndedAt)) {
    const decided = isTurnEndedAt(event.turnEndedAt) ? event.turnEndedAt : carried
    return {
      ...(event.payload.state === 'done' && decided !== undefined ? { turnEndedAt: decided } : {}),
      ...(previous?.hostTurn ? { hostTurn: previous.hostTurn } : {})
    }
  }
  let record = previous?.hostTurn
  const source = event.source
  const isLiveRoot =
    source !== undefined &&
    event.toolAgentId === undefined &&
    event.isReplay !== true &&
    event.providerSessionOnly !== true
  if (isLiveRoot) {
    const { owner, replaced } = resolveOwner(record, { ...event, source })
    if (!record || replaced) {
      // Why: a row saved before this record existed keeps its last end as the current turn's.
      const seededEnd = replaced ? undefined : carried
      record = {
        owner,
        currentTurnKey: 'seed',
        ...(seededEnd !== undefined ? { completed: { turnKey: 'seed', endedAt: seededEnd } } : {})
      }
    } else if (record.owner !== owner) {
      record = { ...record, owner }
    }
    if (event.nativeTurnKey) {
      record = { ...record, currentTurnKey: `turn:${event.nativeTurnKey}` }
    } else if (
      isNewTurnEvent(source, event.hookEventName) &&
      event.payload.sessionBoundary !== true
    ) {
      record = { ...record, currentTurnKey: `opened:${at}` }
    }
  }
  if (event.payload.state !== 'done') {
    return record ? { hostTurn: record } : {}
  }
  if (!record) {
    return carried !== undefined ? { turnEndedAt: carried } : {}
  }
  const completed = record.completed
  if (
    isLiveRoot &&
    event.payload.sessionBoundary !== true &&
    isTurnEndEvent(source, event.hookEventName) &&
    (completed?.turnKey !== record.currentTurnKey || event.stopHookActive === true)
  ) {
    const endedAt = Math.max(at, (completed?.endedAt ?? 0) + 1)
    return {
      turnEndedAt: endedAt,
      hostTurn: { ...record, completed: { turnKey: record.currentTurnKey, endedAt } }
    }
  }
  // Why: a restatement that changed only the session or turn key (no end yet) keeps the shown end.
  const restated = completed?.turnKey === record.currentTurnKey ? completed.endedAt : carried
  return { ...(restated !== undefined ? { turnEndedAt: restated } : {}), hostTurn: record }
}
