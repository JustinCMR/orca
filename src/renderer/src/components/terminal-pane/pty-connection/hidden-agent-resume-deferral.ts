import { useAppStore } from '@/store'
import { getProviderSessionClaimKey } from '@/lib/sleeping-agent-pane-ownership'
import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { takeSleepingAgentWakeRequest } from '@/lib/sleeping-agent-wake-requests'
import { holdPaneResumeUntilShown, releasePaneResumeHold } from '@/lib/pane-spawn-deferral-registry'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ColdRestoreAgentResumeStartup, PaneRestoreOutcome } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Holds a hidden pane's sleeping-agent resume until the pane is shown, by arming the same wake a
 * hibernated pane uses (#7145), so opening a workspace never resumes all its agents at once.
 * Returns false when the resume should start now: the pane is visible, or a background wake asked.
 */
export function deferHiddenAgentResume(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null,
  wake?: () => Promise<PaneRestoreOutcome>
): boolean {
  const recordEntry = startup?.sleepingRecordEntry
  if (
    !recordEntry ||
    session.disposed ||
    session.deps.isVisibleRef.current ||
    session.hiddenAgentResumeReleased
  ) {
    return false
  }
  if (takeSleepingAgentWakeRequest(recordEntry.record)) {
    // Why: later fallbacks in this same connect must not hold what the background wake released.
    session.hiddenAgentResumeReleased = true
    return false
  }
  const start: () => Promise<PaneRestoreOutcome> = wake ?? session.wakeHibernatedAgentPane
  const target = {
    // Why the current id: the wake must drop if another flow binds a PTY first.
    ptyId: session.transport.getPtyId(),
    record: recordEntry.record,
    wake: (): Promise<PaneRestoreOutcome> => {
      session.hiddenAgentResumeReleased = true
      return start()
    }
  }
  session.hibernatedWakeTarget = target
  session.hiddenAgentResumeHeldTarget = target
  // Why: the cleared layout binding no longer proves ownership, so an activation sweep would relaunch the record.
  // The armed target or its claimed operation owns the record until binding.
  const claimKey = getProviderSessionClaimKey(recordEntry.record)
  const previousHold = session.hiddenAgentResumeHold
  session.hiddenAgentResumeHold = (): boolean => {
    const current = session.getSleepingRecordForPane(useAppStore.getState())?.record
    return (
      Boolean(current) &&
      !session.disposed &&
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
      getProviderSessionClaimKey(current) === claimKey &&
      session.hiddenAgentResumeHeldTarget !== null &&
      session.transport.getPtyId() === null &&
      (session.hibernatedWakeTarget === session.hiddenAgentResumeHeldTarget ||
        session.hibernatedWakeInFlightClaimKey === claimKey)
    )
  }
  if (
    session.hiddenAgentResumeHoldKey &&
    session.hiddenAgentResumeHoldKey !== recordEntry.paneKey
  ) {
    releasePaneResumeHold(session.hiddenAgentResumeHoldKey, previousHold)
  }
  session.hiddenAgentResumeHoldKey = recordEntry.paneKey
  holdPaneResumeUntilShown(recordEntry.paneKey, session.hiddenAgentResumeHold)
  return true
}

/** Drops the pane's hold, at its wake or disposal; a later in-session sleep is not a held resume. */
export function releaseHiddenAgentResumeHold(session: ConnectPanePtySession): void {
  session.hiddenAgentResumeHeldTarget = null
  if (session.hiddenAgentResumeHold && session.hiddenAgentResumeHoldKey) {
    releasePaneResumeHold(session.hiddenAgentResumeHoldKey, session.hiddenAgentResumeHold)
  }
}

/** A pane whose process ended is asleep again: a background wake's release and any held resume are over. */
export function noteHiddenAgentResumePtyEnded(session: ConnectPanePtySession): void {
  session.hiddenAgentResumeReleased = false
  // Why: while the held wake is still armed nothing it started has run, so this exit is not its process.
  if (session.hibernatedWakeTarget !== session.hiddenAgentResumeHeldTarget) {
    releaseHiddenAgentResumeHold(session)
  }
}

/**
 * Reattaches a restored session. A hidden pane with a sleeping agent may only adopt its live
 * session; when that fails, the reattach that can resume the agent waits for the pane to be shown.
 */
export function startDeferredSessionReattachUnlessHiddenAgentResume(
  session: ConnectPanePtySession,
  sessionId: string
): void {
  const reattach = () => startDeferredSessionReattach(session, sessionId)
  if (
    // Why local only: attach-only is enforced by this machine's providers, not a paired or SSH host.
    isRemoteRuntimePtyId(sessionId) ||
    session.runtimeEnvironmentId ||
    session.transport.getConnectionId?.() ||
    session.deps.isVisibleRef.current ||
    !session.buildColdRestoreAgentResumeStartup()?.sleepingRecordEntry
  ) {
    reattach()
    return
  }
  void startDeferredSessionReattach(session, sessionId, async (unverifiable) => {
    const deferred = deferHiddenAgentResume(
      session,
      session.buildColdRestoreAgentResumeStartup(),
      reattach
    )
    if (!deferred) {
      return reattach()
    }
    session.settlePaneAttachAttempt('failed')
    if (unverifiable) {
      settleSpawnThatLeftPaneUnbound(session, 'reattach-unverifiable')
    }
    return { kind: 'held', generation: session.transportStreamGeneration }
  })
}
