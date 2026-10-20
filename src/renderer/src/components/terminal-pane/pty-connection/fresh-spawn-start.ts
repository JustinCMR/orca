import type { SpawnDeferralReason } from '../../../../../shared/host-spawn-admission'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { hasWorktreeTeardownStarted } from '@/store/slices/worktree-delete-state-types'
import { PROCESS_BOUNDARY_GROUND } from '../../../../../shared/terminal-mode-reset-profiles'
import { hasPtySerializer } from '../pty-buffer-serializer'
import { writeTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'

import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'
import { STARTUP_CWD_FALLBACK_NOTICE } from './startup-cwd-fallback-notice'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import { shouldWritePtyOutputForeground } from './foreground-output-scan'
import { toProcessExitStartup } from './process-exit-startup'
import type {
  PaneRestoreOutcome,
  ReattachResultDecision,
  PendingStartupCommand,
  FreshSpawnOptions,
  ColdRestoreAgentResumeStartup
} from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { findTerminalTabForPane } from './terminal-tab-id'

export function bindStartFreshSpawn(session: ConnectPanePtySession): void {
  session.startFreshSpawnOutcome = (
    startupOverride?: PendingStartupCommand | null,
    options: FreshSpawnOptions = {}
  ): Promise<PaneRestoreOutcome> => {
    const releaseDeferredCwdFence = (): void => {
      if (!session.transport.getPtyId()) {
        // An abandoned spawn never reaches connect(), so nothing else would ever
        // drain the pre-connect buffer or settle its acknowledged-write promises.
        session.transport.abandonPreconnectInput?.()
        try {
          session.deps.onDeferredCwdSpawnFailed?.()
        } catch {
          // A cleanup callback must not turn a settled spawn into an unhandled rejection.
        }
      }
    }

    if (
      hasWorktreeTeardownStarted(
        useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]
      )
    ) {
      // Why: the worktree is being deleted; its PTYs were just killed for the
      // filesystem teardown. A fresh shell must not spawn into a directory the
      // removal is about to delete (main fences it anyway), and the pane is
      // about to unmount — so skip the doomed respawn instead of racing it.
      releaseDeferredCwdFence()
      return Promise.resolve({ kind: 'held', generation: session.transportStreamGeneration })
    }
    session.authoritativeReattachGeneration += 1
    // Every fresh connect creates or rebinds a PTY. Do not let a legacy
    // response that omits `incarnationId` inherit the predecessor's fence.
    session.remotePtyIncarnationId = null
    session.clearPaneMode2031State()
    session.clearHiddenOutputRestoreState()
    // Why: a canceled old replay clear can preserve xterm's native
    // isUserScrolling flag. A replacement shell must start in follow mode.
    session.resetFreshSpawnFollowOutput()
    // Why: a fresh spawn is a new process, so a restart-in-place must not
    // inherit the old TUI's screen, mouse or kitty modes in xterm or the mirror.
    session.writeInputModeGround(PROCESS_BOUNDARY_GROUND)
    session.prepareFreshShellViewportForSpawn(options)
    const coldRestoreOverride =
      startupOverride && 'launchConfig' in startupOverride
        ? (startupOverride as ColdRestoreAgentResumeStartup)
        : null
    // Why: pre-signal the main process so its cooperation gate suppresses
    // the daemon-snapshot seed for this paneKey. We issue declare and the
    // spawn back-to-back without awaiting, because Electron's
    // ipcRenderer→ipcMain channel preserves order across consecutive invoke
    // calls from the same renderer. The cooperation gate at pty:spawn time
    // sees pendingByPaneKey populated. Settle/clear later echoes the gen
    // token captured here. See docs/mobile-prefer-renderer-scrollback.md.
    const preSignalPromise = session.runtimeEnvironmentId
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
    const clearPreSignaledSerializer = (): void => {
      // A disposed pre-bind connect must not keep a successor behind a slow
      // serializer declaration. Cleanup can finish independently of spawn ownership.
      void preSignalPromise.then((gen) => {
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
      })
    }

    session.transportConnectInFlightSince = Date.now()
    session.pendingSpawnDeferral = null
    const visibleAtSpawn = session.deps.isVisibleRef.current === true
    const effectiveStartup = startupOverride === undefined ? session.paneStartup : startupOverride
    const outputCallbacks = session.captureTransportOutputCallbacks(
      session.reportError,
      toProcessExitStartup(coldRestoreOverride ?? effectiveStartup)
    )
    const spawnedRaw = session.transport.connect({
      url: '',
      cols: session.cols,
      rows: session.rows,
      ...(startupOverride?.command ? { command: startupOverride.command } : {}),
      ...(startupOverride?.env
        ? { env: session.mergeStartupEnvWithPaneIdentity(startupOverride.env) }
        : {}),
      ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
      ...(coldRestoreOverride
        ? { resumeProviderSession: coldRestoreOverride.resumeProviderSession }
        : {}),
      ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
      ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
      ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
      resumeSpawnIntent: visibleAtSpawn ? 'user-resume' : 'automatic-restore',
      ...(session.pendingReplacedPtyId
        ? { claimReplacedPtyId: session.claimPendingReplacedPtyId }
        : {}),
      shouldContinue: () =>
        !session.disposed &&
        (findTerminalTabForPane(useAppStore.getState(), session.deps.worktreeId, session.deps.tabId)
          ?.generation ?? 0) === session.tabGeneration,
      callbacks: outputCallbacks.callbacks
    })

    void Promise.resolve(spawnedRaw)
      .catch(() => null)
      .finally(() => {
        session.transportConnectInFlightSince = null
      })
    const trackedPromise: Promise<PaneRestoreOutcome> = Promise.resolve(spawnedRaw)
      .then(async (spawnedPtyId): Promise<PaneRestoreOutcome> => {
        if (outputCallbacks.generation !== session.transportStreamGeneration) {
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          clearPreSignaledSerializer()
          return { kind: 'superseded', generation: outputCallbacks.generation }
        }
        const resolvedPtyId =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId.id
            : typeof spawnedPtyId === 'string'
              ? spawnedPtyId
              : session.transport.getPtyId()
        const deferral: SpawnDeferralReason | null = resolvedPtyId
          ? null
          : session.pendingSpawnDeferral
        session.pendingSpawnDeferral = null
        if (deferral) {
          // Why before the launch-config cleanup below: a deferred launch is postponed, not dead.
          releaseDeferredCwdFence()
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          session.enterSpawnDeferredSleep(deferral, startupOverride, options, visibleAtSpawn)
          return { kind: 'held', generation: outputCallbacks.generation }
        }
        const connectResult =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId
            : null
        // Old hosts may return a string or an object without the optional
        // field; either way remote evidence must remain client-only
        // unverifiable until a stamped attach result arrives.
        session.remotePtyIncarnationId = connectResult?.incarnationId ?? null
        if (connectResult?.isReattach || connectResult?.exitedBeforeAttach) {
          session.pendingStartupCommand = null
          const decision: ReattachResultDecision = await session.handleReattachResult(
            connectResult,
            null,
            coldRestoreOverride,
            outputCallbacks.generation
          )
          const accepted = decision.kind === 'connected'
          session.finishReattachLiveDataDeferral(
            accepted || decision.kind === 'ended',
            outputCallbacks.generation
          )
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            await (
              accepted
                ? window.api.pty.settlePaneSerializer(session.cacheKey, gen)
                : window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen)
            ).catch(() => {})
          }
          if (outputCallbacks.generation !== session.transportStreamGeneration) {
            return { kind: 'superseded', generation: outputCallbacks.generation }
          }
          if (decision.kind === 'continue-fresh') {
            return session.startFreshColdRestoreAgentResume(coldRestoreOverride, {
              forceBlankRestoredViewport: true
            })
          }
          if (!accepted) {
            releaseDeferredCwdFence()
          }
          return decision.kind === 'connected'
            ? session.acceptPaneRestore(
                decision,
                decision.preparedStartup,
                decision.resumeUnavailable
              )
            : decision
        }
        if (spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId) {
          session.registerEffectiveLaunchConfig(
            spawnedPtyId.launchConfig,
            {
              ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
              ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {})
            },
            coldRestoreOverride
          )
        }
        if (resolvedPtyId) {
          if (connectResult?.startupCwdFallback?.kind === 'worktree') {
            writeTerminalOutput(session.pane.terminal, STARTUP_CWD_FALLBACK_NOTICE, {
              foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
            })
          }
        } else if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          // Why: delayed draft/follow-up delivery keys off this launch
          // registry. If spawn produced no PTY, the launch is no longer a
          // viable delivery target and must not wait for a future pane.
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride)
        }
        if (
          resolvedPtyId &&
          spawnedPtyId &&
          typeof spawnedPtyId === 'object' &&
          'id' in spawnedPtyId &&
          session.activePanePtyBinding !== resolvedPtyId &&
          session.transport.getPtyId() === resolvedPtyId
        ) {
          // Why: daemon createOrAttach can turn an apparent fresh spawn into
          // a reattach; the transport skips onPtySpawn there to preserve recency.
          session.bindActivePanePty(resolvedPtyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
        }
        if (resolvedPtyId) {
          session.reconcilePtySizeAfterSpawn(resolvedPtyId, session.cols, session.rows)
        }
        if (!resolvedPtyId) {
          releaseDeferredCwdFence()
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          return { kind: 'failed', generation: outputCallbacks.generation }
        }
        const gen = await preSignalPromise
        // A bound PTY owns the serializer even when declaration was rejected.
        if (!isRemoteRuntimePtyId(resolvedPtyId) || !hasPtySerializer(resolvedPtyId)) {
          session.registerPaneSerializerFor(resolvedPtyId)
        }
        if (typeof gen === 'number') {
          await window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        session.finishReattachLiveDataDeferral(Boolean(resolvedPtyId), outputCallbacks.generation)
        return session.acceptPaneRestore(
          {
            kind: 'connected',
            ptyId: resolvedPtyId,
            generation: outputCallbacks.generation,
            agentResumed: Boolean(coldRestoreOverride) && !connectResult?.agentResumeUnavailable
          },
          coldRestoreOverride,
          Boolean(connectResult?.agentResumeUnavailable)
        )
      })
      .catch(async (): Promise<PaneRestoreOutcome> => {
        releaseDeferredCwdFence()
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        if (
          outputCallbacks.generation === session.transportStreamGeneration &&
          (session.paneStartup?.launchConfig ||
            (startupOverride && 'launchConfig' in startupOverride))
        ) {
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride)
        }
        clearPreSignaledSerializer()
        return {
          kind:
            outputCallbacks.generation === session.transportStreamGeneration
              ? 'failed'
              : 'superseded',
          generation: outputCallbacks.generation
        }
      })
      .finally(() => {
        if (pendingSpawnByPaneKey.get(session.pendingSpawnKey) === trackedPromise) {
          pendingSpawnByPaneKey.delete(session.pendingSpawnKey)
        }
      })
    void trackedPromise.then((outcome) => {
      if (
        session.disposed ||
        outcome.generation !== session.transportStreamGeneration ||
        session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
      ) {
        return
      }
      if (outcome.kind === 'connected' && outcome.recordAcceptance !== 'absent') {
        // Only the completed selected path can settle recovery successfully.
        session.settlePaneAttachAttempt?.('success')
        return
      }
      if (outcome.kind === 'superseded') {
        session.settlePaneAttachAttempt?.('superseded')
      }
      if (outcome.kind !== 'failed') {
        return
      }
      queueMicrotask(() => {
        if (
          session.disposed ||
          outcome.generation !== session.transportStreamGeneration ||
          session.transport.getPtyId() ||
          pendingSpawnByPaneKey.has(session.pendingSpawnKey)
        ) {
          return
        }
        settleSpawnThatLeftPaneUnbound(session)
      })
    })
    // Why: split panes in the same tab can spawn concurrently. Key by pane
    // as well as tab so a remount cannot attach to a sibling setup pane's PTY.
    pendingSpawnByPaneKey.set(session.pendingSpawnKey, trackedPromise)
    return trackedPromise
  }
  session.startFreshSpawn = (
    startup?: PendingStartupCommand | null,
    options?: FreshSpawnOptions
  ): Promise<string | null> =>
    session
      .startFreshSpawnOutcome(startup, options)
      .then((outcome: PaneRestoreOutcome) => (outcome.kind === 'connected' ? outcome.ptyId : null))
}
