import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectConnectedTerminalError,
  appendPaneTerminalError,
  clearPaneTerminalError
} from './terminal-error-accumulation'
import type { PtyConnectResult } from './pty-transport-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { connectPanePty } from './pty-connection'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

type HiddenPaneBinding = {
  dispose: () => void
  noteVisibilityResume: () => void
  wakeHibernatedAgentIfArmed: (claimed?: Set<string>) => string | null
  isHeldAgentWakeConnected: () => boolean
  retryHeldAgentWake: () => Promise<boolean> | null
}

const PANE_KEY = makePaneKey('tab-1', LEAF_2)
const DEAD_SESSION_ID = 'wt-1@@dead-session'

type ResumingConnectOptions = {
  sessionId?: string
  attachOnly?: boolean
  callbacks?: { onError?: (message: string) => void }
}

/** After a relaunch: one sleeping agent pane with no live PTY. */
export function registerPtyConnectionHiddenSleepingResumeTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []
  let connectPanePtyRef: typeof connectPanePty | null = null
  let hostLiveness: boolean | null = true

  function seedSleepingPane(
    restoredPtyId: string | null,
    record: Record<string, unknown> = {}
  ): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture state carries every field connectPanePty reads; the tab and record literals are partial by design.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }] },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: restoredPtyId ? { [LEAF_2]: restoredPtyId } : {}
        }
      },
      settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'quit',
          ...record
        }
      }
    } as StoreState
  }

  function connectHiddenPane(
    restoredPtyId: string | null,
    transport = createResumingTransport()
  ): {
    transport: MockTransport
    binding: HiddenPaneBinding
    isVisibleRef: { current: boolean }
  } {
    transportFactoryQueue.push(transport)
    const isVisibleRef = { current: false }
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: restoredPtyId ? { [LEAF_2]: restoredPtyId } : {},
      isVisibleRef
    })
    return { transport, binding: connectPane(deps), isVisibleRef }
  }

  /** A pane transport with no PTY until a connect binds one, as after a relaunch. */
  function createResumingTransport(): MockTransport {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: ResumingConnectOptions) => {
      if (opts.attachOnly && hostLiveness !== true) {
        const gone = hostLiveness === false
        opts.callbacks?.onError?.(gone ? `Session not found: ${opts.sessionId}` : 'reconnect')
        return undefined
      }
      const ptyId = opts.sessionId ?? 'resumed-pty'
      transport.getPtyId.mockReturnValue(ptyId)
      return opts.sessionId ? { id: ptyId } : ptyId
    })
    return transport
  }

  function connectPane(deps: ReturnType<typeof buildPaneConnectionDeps>): HiddenPaneBinding {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [createPane(2), createManager(2), deps] as unknown as Parameters<
      typeof connectPanePty
    >
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectPanePty returns the PanePtyBinding, which has both methods.
    return connectPanePtyRef!(...args) as unknown as HiddenPaneBinding
  }

  /** What the host answers a hidden pane's attach-only reattach: live, gone, or unreachable. */
  function setHostLiveness(isLive: boolean | null): void {
    hostLiveness = isLive
  }

  function resumeCommands(transport: MockTransport): (string | undefined)[] {
    return transport.connect.mock.calls.map((call) => call[0]?.command)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      hostLiveness = true
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
      connectPanePtyRef = (await import('./pty-connection')).connectPanePty
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('waits for the reveal before resuming a hidden pane that has no PTY to reattach', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)

      expect(transport.connect).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('holds a hidden reattach the host reports gone, then reattaches it on reveal', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { transport, binding, isVisibleRef } = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: DEAD_SESSION_ID, attachOnly: true })
      )

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(2)
      // The reveal takes the same reattach a visible pane would, so the host restores its scrollback.
      expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({ sessionId: DEAD_SESSION_ID })
      expect(transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('attachOnly')
      expect(resumeCommands(transport)[1]).toContain("'resume' 'codex-session-1'")
    })

    it.each(['reconnect', 'terminal_pane_owner_unverified'])(
      'recovers a hidden uncertain attach (%s) without granting creation, then reveals the live session',
      async (message) => {
        seedSleepingPane(DEAD_SESSION_ID)
        setHostLiveness(null)
        const remount = vi.fn(() => ({ remounted: true, generation: 1 }))
        Object.assign(mockStoreState, { remountTerminalTabForRecovery: remount })
        const first = connectHiddenPane(DEAD_SESSION_ID)
        first.transport.connect.mockImplementation(async (opts: ResumingConnectOptions) => {
          opts.callbacks?.onError?.(message)
          return undefined
        })
        await flushAsyncTicks(10)
        expect(first.transport.connect).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionId: DEAD_SESSION_ID, attachOnly: true })
        )
        expect(remount).toHaveBeenCalledExactlyOnceWith(
          'tab-1',
          expect.objectContaining({
            reason: 'reattach-unverifiable',
            trigger: 'automatic'
          })
        )
        expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId?.[LEAF_2]).toBe(
          DEAD_SESSION_ID
        )
        first.binding.dispose()
        setHostLiveness(true)
        const recovered = connectHiddenPane(DEAD_SESSION_ID)
        await flushAsyncTicks(10)
        expect(recovered.transport.connect).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sessionId: DEAD_SESSION_ID,
            attachOnly: true
          })
        )
        expect(recovered.transport.getPtyId).toHaveLastReturnedWith(DEAD_SESSION_ID)
        expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
        recovered.isVisibleRef.current = true
        recovered.binding.noteVisibilityResume()
        await flushAsyncTicks(10)
        expect(recovered.transport.connect).toHaveBeenCalledTimes(1)
      }
    )

    it('keeps an exhausted background hold retryable after a failed explicit wake and fences disposal', async () => {
      seedSleepingPane(DEAD_SESSION_ID, { state: 'done', origin: 'worktree-sleep' })
      mockStoreState.activeWorktreeId = 'another-worktree'
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const remount = vi.fn(() => ({ remounted: false, declinedBy: 'settled-failure' }))
      Object.assign(mockStoreState, { remountTerminalTabForRecovery: remount })
      setHostLiveness(null)
      const held = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
      held.transport.connect.mockResolvedValueOnce(undefined)
      await expect(held.binding.retryHeldAgentWake()).resolves.toBe(false)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
      expect(held.transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('attachOnly')
      held.transport.connect
        .mockResolvedValueOnce({ id: DEAD_SESSION_ID, isReattach: true })
        .mockResolvedValueOnce(undefined)
      await expect(held.binding.retryHeldAgentWake()).resolves.toBe(false)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
      const late = createDeferred<void>()
      held.transport.connect.mockImplementationOnce(() => late.promise)
      const pending = held.binding.retryHeldAgentWake()
      held.binding.dispose()
      const successor = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)
      late.resolve()
      await expect(pending).resolves.toBe(false)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
      setHostLiveness(true)
      await expect(successor.binding.retryHeldAgentWake()).resolves.toBe(true)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })

    it('authorizes exactly one full restore if reveal wins the initial attach race', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      const transport = createResumingTransport()
      const attach = createDeferred<void>()
      transport.connect.mockImplementationOnce((opts: ResumingConnectOptions) =>
        attach.promise.then(() => {
          opts.callbacks?.onError?.(`Session not found: ${opts.sessionId}`)
        })
      )
      const held = connectHiddenPane(DEAD_SESSION_ID, transport)
      await flushAsyncTicks(10)
      held.isVisibleRef.current = true
      held.binding.noteVisibilityResume()
      attach.resolve()
      await flushAsyncTicks(20)
      expect(held.transport.connect).toHaveBeenCalledTimes(2)
      expect(held.transport.connect.mock.calls[0]?.[0]).toMatchObject({
        sessionId: DEAD_SESSION_ID,
        attachOnly: true
      })
      expect(held.transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('attachOnly')
      expect(held.transport.getPtyId).toHaveLastReturnedWith(DEAD_SESSION_ID)
    })

    it('resumes a hidden pane at mount when a background mount asked for its tab', async () => {
      seedSleepingPane(null)
      const { requestSleepingAgentWakeOnMount } = await import('@/lib/sleeping-agent-wake-requests')
      requestSleepingAgentWakeOnMount('wt-1', ['tab-1'])
      const { transport } = connectHiddenPane(null)
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('resumes a held hidden pane immediately on a phone wake', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { transport, binding } = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      const claimed = new Set<string>()
      expect(binding.wakeHibernatedAgentIfArmed(claimed)).not.toBeNull()
      expect(binding.wakeHibernatedAgentIfArmed(claimed)).toBeNull()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({ sessionId: DEAD_SESSION_ID })
    })

    it('owns its record while held, so an activation sweep does not relaunch it elsewhere', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const { binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })

    it('keeps a background wake released through a failed reattach fallback', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { requestSleepingAgentWakeOnMount } = await import('@/lib/sleeping-agent-wake-requests')
      requestSleepingAgentWakeOnMount('wt-1', ['tab-1'])
      const transport = createMockTransport()
      // The attach-only and woken reattaches come back with no PTY, so the pane falls back to a fresh resume.
      transport.connect
        .mockImplementationOnce(async (opts: ResumingConnectOptions) => {
          opts.callbacks?.onError?.(`Session not found: ${opts.sessionId}`)
          return undefined
        })
        .mockImplementationOnce(async (opts: ResumingConnectOptions) => {
          opts.callbacks?.onError?.(`Session not found: ${opts.sessionId}`)
          return undefined
        })
        .mockResolvedValue('resumed-pty')
      transportFactoryQueue.push(transport)
      connectPane(
        buildPaneConnectionDeps(() => mockStoreState, {
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: DEAD_SESSION_ID },
          isVisibleRef: { current: false }
        })
      )
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(3)
      expect(resumeCommands(transport)[2]).toContain("'resume' 'codex-session-1'")
    })

    it('keeps owning its record while the woken resume is still starting', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const spawn = createDeferred<string>()
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      transport.connect.mockImplementation(() =>
        spawn.promise.then((ptyId) => {
          transport.getPtyId.mockReturnValue(ptyId)
          return ptyId
        })
      )
      await flushAsyncTicks(10)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      spawn.resolve('resumed-pty')
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })

    it('does not count a later in-session sleep of the woken pane as held', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const isVisibleRef = { current: false }
      const transport = createResumingTransport()
      transportFactoryQueue.push(transport)
      const binding = connectPane(
        buildPaneConnectionDeps(() => mockStoreState, {
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: {},
          consumeSuppressedPtyExit: vi.fn(() => true),
          isVisibleRef
        })
      )
      await flushAsyncTicks(10)
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Hibernation sleeps the hidden pane again: its own wake, which the activation sweep may clean around.
      isVisibleRef.current = false
      seedSleepingPane(null, { state: 'done', origin: 'worktree-sleep' })
      mockStoreState.suppressedPtyExitIds['resumed-pty'] = true
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      if (typeof onPtyExit !== 'function') {
        throw new Error('expected the transport exit handler')
      }
      onPtyExit('resumed-pty')
      await flushAsyncTicks(10)

      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
      // The in-session wake is still armed, so the reveal resumes the pane again.
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(2)
    })

    it('resumes a held pane whose record was re-captured for the same session', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)
      const held = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
      mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = { ...held, updatedAt: 2 }

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('drops a held wake once the record names a different session', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)
      const held = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
      mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = {
        ...held,
        providerSession: { key: 'session_id', id: 'codex-session-2' }
      }

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).not.toHaveBeenCalled()
    })

    it.each([
      'success',
      'record-string',
      'record-object',
      'record-null',
      'record-throw',
      'record-serializer',
      'recapture',
      'after-child'
    ])('completes empty adoption: %s', async (outcome) => {
      seedSleepingPane(DEAD_SESSION_ID, { state: 'done', origin: 'worktree-sleep' })
      setHostLiveness(false)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const tab = () => mockStoreState.tabsByWorktree['wt-1'][0]
      tab().recovery = {
        generation: 1,
        outcome: 'pending',
        attemptedAt: [1],
        startedAt: Date.now(),
        reason: 'reattach-unverifiable',
        tabGeneration: 0
      }
      let errors = appendPaneTerminalError({}, 2, 'terminal_reattach_unverifiable')
      errors = appendPaneTerminalError(errors, 2, 'terminal_pane_owner_unverified')
      errors = appendPaneTerminalError(errors, 2, 'unrelated')
      const cleared = vi.fn((id: number, message?: string) => {
        errors = clearPaneTerminalError(errors, id, message)
      })
      const transport = createResumingTransport()
      transportFactoryQueue.push(transport)
      const isVisibleRef = { current: false }
      const binding = connectPane(
        buildPaneConnectionDeps(() => mockStoreState, {
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: DEAD_SESSION_ID },
          isVisibleRef,
          onPtyErrorClearedRef: { current: cleared }
        })
      )
      await flushAsyncTicks(10)
      tab().recovery!.outcome = 'pending'
      const fallback = createDeferred<string | PtyConnectResult | null>()
      const serializer = createDeferred<void>()

      // Empty adoption retires before the selected fresh resume starts.
      transport.connect
        .mockResolvedValueOnce({ id: DEAD_SESSION_ID, isReattach: true })
        .mockImplementationOnce(() =>
          fallback.promise.then((result) => {
            transport.getPtyId.mockReturnValue(
              typeof result === 'string' ? result : (result?.id ?? null)
            )
            return result
          })
        )

      if (outcome === 'record-serializer') {
        vi.mocked(window.api.pty.settlePaneSerializer).mockReturnValueOnce(serializer.promise)
      }
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(20)
      expect(transport.connect).toHaveBeenCalledTimes(3)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      const pending = binding.retryHeldAgentWake()
      expect(pending).not.toBeNull()
      let completed = false
      void pending?.then(() => {
        completed = true
      })
      binding.wakeHibernatedAgentIfArmed(new Set())
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(completed).toBe(false)
      expect(transport.connect).toHaveBeenCalledTimes(3)
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const selected = [...pendingSpawnByPaneKey.values()][0]
      expect(tab().recovery?.outcome).toBe('pending')
      const recipe = { agentCommand: 'codex', agentArgs: '--model successor', agentEnv: {} }
      const replace = () => {
        const record = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
        mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = {
          ...record,
          updatedAt: 3,
          providerSession: { key: 'session_id', id: 'successor-session' }
        }
        mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY] = { launchConfig: recipe }
      }
      if (outcome.startsWith('record') && outcome !== 'record-serializer') {
        replace()
      }
      if (outcome === 'recapture') {
        const record = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
        mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = { ...record, updatedAt: 9 }
      }
      if (outcome === 'after-child') {
        const heartbeat = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
        void selected.then(() => {
          mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = { ...heartbeat, updatedAt: 10 }
        })
      }
      if (outcome === 'record-throw') {
        fallback.reject(new Error('old child failed'))
      } else {
        fallback.resolve(
          outcome === 'record-null'
            ? null
            : outcome === 'record-object'
              ? { id: 'resumed-pty', launchConfig: { ...recipe, agentArgs: '--model old' } }
              : 'resumed-pty'
        )
      }
      if (outcome === 'record-serializer') {
        await vi.waitFor(() => expect(window.api.pty.settlePaneSerializer).toHaveBeenCalled())
        expect(tab().recovery?.outcome).toBe('pending')
        replace()
        serializer.resolve()
      }
      const failed = outcome === 'record-null' || outcome === 'record-throw'
      await expect(pending).resolves.toBe(!failed)
      await expect(selected).resolves.toMatchObject({
        kind: failed ? 'failed' : outcome.startsWith('record') ? 'superseded' : 'connected'
      })
      expect(tab().recovery?.outcome).toBe(
        failed ? 'failed' : outcome.startsWith('record') ? 'superseded' : 'success'
      )
      if (outcome.startsWith('record')) {
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
          providerSession: { id: 'successor-session' }
        })
        expect(mockStoreState.agentLaunchConfigByPaneKey[PANE_KEY]?.launchConfig).toEqual(recipe)
        expect(cleared).not.toHaveBeenCalled()
        const stored = errors[2].join('\n')
        expect(projectConnectedTerminalError(stored, binding.isHeldAgentWakeConnected())).toBe(
          failed ? stored : 'unrelated'
        )
        if (!failed) {
          await expect(binding.retryHeldAgentWake()).resolves.toBe(true)
        }
        expect(transport.connect).toHaveBeenCalledTimes(3)
      } else {
        expect(errors[2]).toEqual(['unrelated'])
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(
          outcome === 'after-child' ? expect.any(Object) : undefined
        )
      }
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })

    it('keeps holding when an exit lands that its held wake did not start', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      connectHiddenPane(null)
      await flushAsyncTicks(10)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      if (typeof onPtyExit !== 'function') {
        throw new Error('expected the transport exit handler')
      }

      onPtyExit('stale-restored-pty')
      await flushAsyncTicks(10)

      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
    })
  })
}
