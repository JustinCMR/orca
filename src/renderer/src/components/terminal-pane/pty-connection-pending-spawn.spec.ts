import { makePaneKey } from '../../../../shared/stable-pane-id'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionPendingSpawnTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
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
    })

    afterEach(async () => {
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      pendingSpawnByPaneKey.clear()
      await restoreTerminalTestGlobals()
    })

    it('does not retain PTY connect diagnostics unless e2e debug state is enabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()

      expect((globalThis as Record<string, unknown>).__ptyConnectDiag).toBeUndefined()
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[pty-connect]'))
      logSpy.mockRestore()
    }, 30_000)

    it('does not hold a successor behind a canceled spawn serializer declaration', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const declaration = createDeferred<number>()
      const spawn = createDeferred<null>()
      const transport = createMockTransport()
      transport.connect.mockReturnValueOnce(spawn.promise)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      vi.mocked(window.api.pty.declarePendingPaneSerializer).mockReturnValueOnce(
        declaration.promise
      )

      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks(12)
      expect(pendingSpawnByPaneKey.size).toBe(1)
      binding.dispose()
      spawn.resolve(null)
      await flushAsyncTicks(12)

      expect(pendingSpawnByPaneKey.size).toBe(0)
      expect(window.api.pty.clearPendingPaneSerializer).not.toHaveBeenCalled()

      declaration.resolve(7)
      await flushAsyncTicks(12)

      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        7
      )
    })

    it('joins the selected nested spawn across a StrictMode remount', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pendingSpawn = createDeferred<string>()
      const firstTransport = createMockTransport()
      firstTransport.connect
        .mockResolvedValueOnce({ id: 'empty-adoption', isReattach: true })
        .mockReturnValueOnce(pendingSpawn.promise)
      vi.mocked(window.api.pty.declarePendingPaneSerializer)
        .mockResolvedValueOnce(11)
        .mockResolvedValueOnce(12)
      const remountTransport = createMockTransport()
      transportFactoryQueue.push(firstTransport, remountTransport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
        sleepingAgentSessionsByPaneKey: {
          [makePaneKey('tab-1', LEAF_1)]: {
            paneKey: makePaneKey('tab-1', LEAF_1),
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'nested-session' },
            prompt: '',
            state: 'done',
            origin: 'worktree-sleep',
            capturedAt: 1,
            updatedAt: 1
          }
        },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const remountDeps = createDeps()

      const firstBinding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks(20)
      expect(firstTransport.connect).toHaveBeenCalledTimes(2)
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 11)
      expect(
        vi.mocked(window.api.pty.clearPendingPaneSerializer).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(window.api.pty.declarePendingPaneSerializer).mock.invocationCallOrder[1]
      )
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const selected = [...pendingSpawnByPaneKey.values()][0]
      firstBinding.dispose()
      connectPanePty(createPane(1) as never, createManager(1) as never, remountDeps as never)
      await flushAsyncTicks()

      expect(firstTransport.connect).toHaveBeenCalledTimes(2)
      expect(remountTransport.connect).not.toHaveBeenCalled()

      const spawnedPtyId = 'pty-strict-mode'
      pendingSpawn.resolve(spawnedPtyId)
      await expect(selected).resolves.toMatchObject({
        kind: 'connected',
        ptyId: spawnedPtyId,
        generation: 2
      })
      await flushAsyncTicks(12)
      expect(pendingSpawnByPaneKey.size).toBe(0)
      expect(window.api.pty.settlePaneSerializer).toHaveBeenCalledWith(expect.any(String), 12)

      expect(remountTransport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: spawnedPtyId })
      )
      expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', spawnedPtyId)
    })
  })
}
