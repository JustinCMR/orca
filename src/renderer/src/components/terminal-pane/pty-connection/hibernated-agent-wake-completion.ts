import { useAppStore } from '@/store'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type HibernatedWakeTarget = {
  ptyId: string | null
  record: SleepingAgentSessionRecord
  wake?: () => Promise<string | null | undefined>
}

/** Completes the claimed wake and retains its target only for a current failed attempt. */
export function completeHibernatedAgentWake(
  session: ConnectPanePtySession,
  target: HibernatedWakeTarget,
  claimKey: string
): void {
  const wake: () => Promise<string | null | undefined> =
    target.wake ?? session.wakeHibernatedAgentPane
  let attempt: Promise<string | null | undefined>
  try {
    attempt = wake()
  } catch {
    attempt = Promise.resolve(null)
  }
  const wakeGeneration = session.transportStreamGeneration
  const completion = attempt
    .catch((error: unknown) => {
      console.warn('[terminal] held wake failed:', error)
      return null
    })
    .then((spawnedPtyId) => {
      const current = session.getSleepingRecordForPane(useAppStore.getState())?.record
      const ownsWake =
        !session.disposed &&
        session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
        session.hibernatedWakeInFlightClaimKey === claimKey
      if (
        spawnedPtyId === null &&
        ownsWake &&
        current &&
        getProviderSessionClaimKey(current) === claimKey &&
        (target.wake || session.transportStreamGeneration === wakeGeneration) &&
        session.hibernatedWakeTarget === null &&
        (session.transport.getPtyId() === null || session.transport.getPtyId() === target.ptyId)
      ) {
        session.hibernatedWakeTarget = target
      }
      return Boolean(spawnedPtyId && ownsWake && session.transport.getPtyId() === spawnedPtyId)
    })
    .finally(() => {
      if (session.hibernatedWakeCompletion === completion) {
        session.hibernatedWakeInFlightClaimKey = null
        session.hibernatedWakeCompletion = null
      }
    })
  session.hibernatedWakeCompletion = completion
}
