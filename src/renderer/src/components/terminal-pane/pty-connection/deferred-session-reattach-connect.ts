import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { isSshSessionGoneError, recordPtyConnectDiagnostic } from './pty-connect-limits'
import { toProcessExitStartup } from './process-exit-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PaneRestoreOutcome, ReattachResultDecision } from './fresh-spawn-types'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../shared/newer-daemon-hold'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { holdInPlaceResumeUntilSettled } from './in-place-resume-hold'

import {
  awaitAgentStatusStartupSnapshot,
  isAgentStatusStartupSnapshotReady
} from '@/hooks/ipc-events/agent-status-startup-snapshot'

const PANE_OWNER_UNVERIFIED_ERROR = 'terminal_pane_owner_unverified'

/** With `onNotAttached`, the reattach may only adopt a live session; any other outcome calls it instead. */
export function startDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  onNotAttached?: (unverifiable: boolean) => Promise<PaneRestoreOutcome>
): Promise<PaneRestoreOutcome> {
  const generation = session.transportStreamGeneration
  return prepareDeferredSessionReattach(session, deferredReattachSessionId, onNotAttached).catch(
    (error: unknown) => {
      if (!session.disposed) {
        session.reportError(error instanceof Error ? error.message : String(error))
      }
      return {
        kind: generation === session.transportStreamGeneration ? 'failed' : 'superseded',
        generation
      }
    }
  )
}

async function prepareDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  onNotAttached?: (unverifiable: boolean) => Promise<PaneRestoreOutcome>
): Promise<PaneRestoreOutcome> {
  const generation = session.transportStreamGeneration
  let waitedForSnapshot = false
  if (
    !session.runtimeEnvironmentId &&
    !session.buildColdRestoreAgentResumeStartup() &&
    !isAgentStatusStartupSnapshotReady()
  ) {
    waitedForSnapshot = true
    await awaitAgentStatusStartupSnapshot()
  }
  if (
    session.disposed ||
    generation !== session.transportStreamGeneration ||
    (waitedForSnapshot &&
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport)
  ) {
    return { kind: 'superseded', generation }
  }
  return connectDeferredSessionReattach(session, deferredReattachSessionId, onNotAttached)
}

/** Resolves to what the reattach did, which a held pane's release reports. */
function connectDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string,
  onNotAttached?: (unverifiable: boolean) => Promise<PaneRestoreOutcome>
): Promise<PaneRestoreOutcome> {
  session.allowInitialIdleCacheSeed = true
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> REATTACH ${deferredReattachSessionId}`)

  // Why: pre-signal (declare) before the reattach connect so the cooperation gate suppresses the daemon seed for this paneKey; Electron preserves IPC order.
  // See docs/mobile-prefer-renderer-scrollback.md (Renderer-side prerequisite requirement #4).
  const preSignalPromise =
    session.runtimeEnvironmentId || isRemoteRuntimePtyId(deferredReattachSessionId)
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)

  let expiredReattachError = false
  let paneOwnerUnverified = false
  let heldByNewerDaemon = false
  let sessionNotFound = false
  const isHeldWake = Boolean(
    session.hiddenAgentResumeHeldTarget && session.hiddenAgentResumeReleased
  )
  const coldRestoreStartup = session.buildColdRestoreAgentResumeStartup()
  const outputCallbacks = session.captureTransportOutputCallbacks(
    (message) => {
      if (isSshSessionGoneError(message)) {
        expiredReattachError = true
        return
      }
      // Why local only: a paired host refuses for its own daemon, which this window cannot stop.
      if (!session.runtimeEnvironmentId && message.includes(NEWER_DAEMON_HOLD_ERROR)) {
        heldByNewerDaemon = true
        return
      }
      if (message.includes(PANE_OWNER_UNVERIFIED_ERROR)) {
        paneOwnerUnverified = true
      }
      sessionNotFound = message.endsWith(`Session not found: ${deferredReattachSessionId}`)
      if (onNotAttached || isHeldWake) {
        return
      }
      session.reportError(message)
    },
    toProcessExitStartup(coldRestoreStartup ?? session.paneStartup)
  )
  session.beginReattachLiveDataDeferral(outputCallbacks.generation)
  session.transportConnectInFlightSince = Date.now()
  const reattachPromise = session.transport.connect({
    url: '',
    cols: session.cols,
    rows: session.rows,
    sessionId: deferredReattachSessionId,
    ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
    ...(coldRestoreStartup?.env
      ? { env: session.mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
      : {}),
    ...(coldRestoreStartup?.launchConfig ? { launchConfig: coldRestoreStartup.launchConfig } : {}),
    ...(coldRestoreStartup?.resumeProviderSession
      ? { resumeProviderSession: coldRestoreStartup.resumeProviderSession }
      : {}),
    ...(coldRestoreStartup?.launchToken ? { launchToken: coldRestoreStartup.launchToken } : {}),
    ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
    ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
    ...(onNotAttached ? { attachOnly: true } : {}),
    callbacks: outputCallbacks.callbacks
  })
  const isCurrentReattach = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    outputCallbacks.generation === session.transportStreamGeneration
  const startFreshInstead = (): Promise<PaneRestoreOutcome> =>
    session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
      forceBlankRestoredViewport: true
    })

  void Promise.resolve(reattachPromise)
    .catch(() => null)
    .finally(() => {
      session.transportConnectInFlightSince = null
    })
  const finishFailedReattach = async (): Promise<boolean> => {
    session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
    const gen = await preSignalPromise
    if (typeof gen === 'number') {
      await window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
    }
    return isCurrentReattach()
  }
  const failUnverifiable = (): PaneRestoreOutcome => {
    session.settlePaneAttachAttempt('failed')
    if (session.deps.isVisibleRef.current || isHeldWake) {
      session.reportError(
        paneOwnerUnverified ? PANE_OWNER_UNVERIFIED_ERROR : 'terminal_reattach_unverifiable'
      )
    }
    return { kind: 'failed', generation: outputCallbacks.generation }
  }
  const outcome = Promise.resolve(reattachPromise)
    .then(async (result): Promise<PaneRestoreOutcome> => {
      if (!isCurrentReattach()) {
        await finishFailedReattach()
        return { kind: 'superseded', generation: outputCallbacks.generation }
      }
      if (!result) {
        if (!(await finishFailedReattach())) {
          return { kind: 'superseded', generation: outputCallbacks.generation }
        }
        if (heldByNewerDaemon) {
          holdForNewerDaemon(session, deferredReattachSessionId, async () => {
            const result = await connectDeferredSessionReattach(session, deferredReattachSessionId)
            return {
              reopened: result.kind === 'connected',
              agentResumed: result.kind === 'connected' && result.agentResumed
            }
          })
          return { kind: 'held', generation: outputCallbacks.generation }
        }
        if (onNotAttached) {
          return onNotAttached(!sessionNotFound)
        }
        if (paneOwnerUnverified || (isHeldWake && !sessionNotFound)) {
          return failUnverifiable()
        }
        if (isHeldWake) {
          return startFreshInstead()
        }
      }
      if (!result && expiredReattachError) {
        session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
        session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
        return startFreshInstead()
      }
      const decision: ReattachResultDecision = await session.handleReattachResult(
        result,
        deferredReattachSessionId,
        coldRestoreStartup,
        outputCallbacks.generation
      )
      const accepted = decision.kind === 'connected'
      session.finishReattachLiveDataDeferral(
        accepted || decision.kind === 'ended',
        outputCallbacks.generation
      )
      const gen = await preSignalPromise
      if (typeof gen === 'number') {
        if (!accepted) {
          await window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        } else if (!isRemoteRuntimePtyId(deferredReattachSessionId)) {
          const settledPtyId =
            result && typeof result === 'object' && 'id' in result
              ? result.id
              : (session.transport.getPtyId() ?? deferredReattachSessionId)
          const hasRestorePayload =
            result &&
            typeof result === 'object' &&
            ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
          await (hasRestorePayload
            ? session.settlePaneSerializerAfterReplay(settledPtyId, gen)
            : window.api.pty.settlePaneSerializer(session.cacheKey, gen))
        }
      }
      if (!isCurrentReattach()) {
        return { kind: 'superseded', generation: outputCallbacks.generation }
      }
      if (decision.kind === 'continue-fresh') {
        return startFreshInstead()
      }
      const final =
        decision.kind === 'connected'
          ? session.acceptPaneRestore(
              decision,
              decision.preparedStartup,
              decision.resumeUnavailable
            )
          : decision
      if (final.kind === 'connected' && final.recordAcceptance !== 'absent') {
        session.settlePaneAttachAttempt?.('success')
      } else if (final.kind === 'failed' || final.kind === 'superseded') {
        session.settlePaneAttachAttempt?.(final.kind)
      }
      return final
    })
    .catch(async (err): Promise<PaneRestoreOutcome> => {
      if (!(await finishFailedReattach())) {
        return { kind: 'superseded', generation: outputCallbacks.generation }
      }
      const message = err instanceof Error ? err.message : String(err)
      sessionNotFound = message.endsWith(`Session not found: ${deferredReattachSessionId}`)
      paneOwnerUnverified = message.includes(PANE_OWNER_UNVERIFIED_ERROR)
      if (onNotAttached) {
        return onNotAttached(!sessionNotFound)
      }
      if (paneOwnerUnverified || isHeldWake) {
        return failUnverifiable()
      }
      warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.deps.restoredLeafId ?? session.pane.leafId,
        paneId: session.pane.id,
        ptyId: deferredReattachSessionId,
        reason: message
      })
      session.reportError(message)
      session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
      session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
      return startFreshInstead()
    })
  // Switch point: main clears the gone terminal's binding before this reattach's fresh start.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    holdInPlaceResumeUntilSettled(() => !session.disposed, coldRestoreStartup, outcome)
  }
  return outcome
}
