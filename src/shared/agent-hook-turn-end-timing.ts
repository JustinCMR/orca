import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isTurnEndEvent } from './agent-hook-listener/provider-event-routing'

type TurnEndTimingRow = Pick<AgentHookEventPayload, 'turnEndedAt' | 'payload'>

function isTurnEndedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * When the main agent's latest turn ended, on the execution host's clock. Only the host sees the
 * event name, so it decides: a live root turn-end event mints a new stamp, and every restatement
 * (idle reminders, session events, replays, child re-emits, result retries) carries the old one
 * while the row stays `done`. A row that leaves `done` drops it, so no later turn can reuse it.
 */
export function resolveTurnEndedAt(
  previous: TurnEndTimingRow | undefined,
  event: AgentHookEventPayload,
  at: number,
  canMint: boolean
): number | undefined {
  if (event.payload.state !== 'done') {
    return undefined
  }
  // Why: a relay or a result retry already decided this event's end; the host restates its answer.
  if (isTurnEndedAt(event.turnEndedAt)) {
    return event.turnEndedAt
  }
  const previousTurnEndedAt =
    previous?.payload.state === 'done' && isTurnEndedAt(previous.turnEndedAt)
      ? previous.turnEndedAt
      : undefined
  const isLiveRootTurnEnd =
    canMint &&
    event.source !== undefined &&
    event.toolAgentId === undefined &&
    event.isReplay !== true &&
    event.providerSessionOnly !== true &&
    event.payload.sessionBoundary !== true &&
    isTurnEndEvent(event.source, event.hookEventName)
  // Why: a turn-end event on a finished row is a new end only when the agent says it re-entered
  // after a blocking Stop hook; otherwise it restates (a late or duplicated delivery).
  if (isLiveRootTurnEnd && (previous?.payload.state !== 'done' || event.stopHookActive === true)) {
    return Math.max(at, (previousTurnEndedAt ?? 0) + 1)
  }
  return previousTurnEndedAt
}
