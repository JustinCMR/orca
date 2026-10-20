import { releaseHiddenAgentResumeHold } from './hidden-agent-resume-deferral'
import type { PaneRestoreOutcome } from './fresh-spawn-types'
import { useAppStore } from '@/store'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type HibernatedWakeTarget = {
  ptyId: string | null
  record: SleepingAgentSessionRecord
  wake?: () => Promise<PaneRestoreOutcome>
}

type HibernatedWakeCompletion = { outcome: PaneRestoreOutcome | null; promise: Promise<boolean> }

/** Presentation follows the completed connection without accepting a superseded saved record. */
export function isHibernatedWakeConnected(session: ConnectPanePtySession): boolean {
  const outcome: PaneRestoreOutcome | null = session.hibernatedWakeCompletion?.outcome ?? null
  return Boolean(
    outcome &&
    (outcome.kind === 'connected' || outcome.kind === 'superseded') &&
    outcome.ptyId &&
    !session.disposed &&
    outcome.generation === session.transportStreamGeneration &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    session.transport.getPtyId() === outcome.ptyId &&
    session.transport.isConnected()
  )
}

/** Completes the claimed wake and retains its target only for a current failed attempt. */
export function completeHibernatedAgentWake(
  session: ConnectPanePtySession,
  target: HibernatedWakeTarget,
  claimKey: string
): void {
  const wake: () => Promise<PaneRestoreOutcome> = target.wake ?? session.wakeHibernatedAgentPane
  const generation = session.transportStreamGeneration
  let attempt: Promise<PaneRestoreOutcome>
  try {
    attempt = wake()
  } catch {
    attempt = Promise.resolve({ kind: 'failed', generation })
  }
  const completion: HibernatedWakeCompletion = { outcome: null, promise: Promise.resolve(false) }
  session.hibernatedWakeCompletion = completion
  completion.promise = attempt
    .catch(() => ({ kind: 'failed', generation }) as const)
    .then((outcome) => {
      const current = session.getSleepingRecordForPane(useAppStore.getState())?.record
      const matching = current && getProviderSessionClaimKey(current) === claimKey
      const ownsWake =
        !session.disposed &&
        session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
        session.hibernatedWakeInFlightClaimKey === claimKey &&
        outcome.generation === session.transportStreamGeneration &&
        session.hibernatedWakeTarget === null
      if (
        outcome.kind === 'failed' &&
        ownsWake &&
        matching &&
        (session.transport.getPtyId() === null || session.transport.getPtyId() === target.ptyId)
      ) {
        session.hibernatedWakeTarget = target
      }
      if (ownsWake) {
        completion.outcome = outcome
      }
      const connected = isHibernatedWakeConnected(session)
      const accepted =
        outcome.kind === 'connected' &&
        outcome.recordAcceptance !== 'absent' &&
        (current ? matching : outcome.recordAcceptance === 'accepted')
      if (connected && accepted && session.hiddenAgentResumeHeldTarget === target) {
        for (const message of [
          'terminal_reattach_unverifiable',
          'terminal_pane_owner_unverified'
        ]) {
          session.deps.onPtyErrorClearedRef?.current?.(session.pane.id, message)
        }
        releaseHiddenAgentResumeHold(session)
      }
      if (connected) {
        session.deps.onPtyRecoveryStateRef?.current?.(session.pane.id, {
          phase: 'connected',
          epoch: outcome.generation,
          attempt: 0
        })
      }
      return connected
    })
    .finally(() => {
      if (session.hibernatedWakeCompletion === completion) {
        session.hibernatedWakeInFlightClaimKey = null
        if (!isHibernatedWakeConnected(session)) {
          session.hibernatedWakeCompletion = null
        }
      }
    })
}
