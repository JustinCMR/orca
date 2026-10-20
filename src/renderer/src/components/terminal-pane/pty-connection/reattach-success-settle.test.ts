import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { PtyConnectResult } from '../pty-transport-types'
import { bindHandleReattachResult } from './reattach-result-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const mocks = vi.hoisted(() => ({
  state: { tabsByWorktree: {}, terminalLayoutsByTabId: {} },
  apply: vi.fn(async () => {})
}))

vi.mock('./apply-reattach-payload', () => ({
  createReattachPayloadHandlers: () => ({
    applyReattachPayload: mocks.apply,
    fitAfterReattachRestore: async () => {}
  })
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

type SettleSpy = ReturnType<typeof vi.fn>

function buildSession(overrides: Record<string, unknown> = {}): {
  session: ConnectPanePtySession
  settlePaneAttachAttempt: SettleSpy
} {
  const settlePaneAttachAttempt = vi.fn()
  const transport = {
    connect: vi.fn(),
    getPtyId: () => 'pty-1',
    disconnect: vi.fn(),
    serializeBuffer: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the session members read by the selected reattach path.
  const session = {
    settlePaneAttachAttempt,
    transport,
    disposed: false,
    runtimeEnvironmentId: 'test-runtime',
    buildColdRestoreAgentResumeStartup: () => null,
    captureTransportOutputCallbacks: () => ({ generation: 0, callbacks: {} }),
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    acceptPaneRestore: (outcome: unknown) => outcome,
    transportStreamGeneration: 0,
    authoritativeReattachGeneration: 0,
    pane: { id: 'pane-1', leafId: 'leaf-1', terminal: {} },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: new Map([['pane-1', transport]]) },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn(),
      updateTabPtyId: vi.fn(),
      restoredLeafId: null
    },
    registerEffectiveLaunchConfig: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn().mockResolvedValue({ kind: 'failed', generation: 0 }),
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    sampleVisiblePaneForegroundAgent: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    scheduleReattachIdleAgentCursorReset: vi.fn(),
    setPanePtyFitBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    ...overrides
  } as unknown as ConnectPanePtySession
  bindHandleReattachResult(session)
  return { session, settlePaneAttachAttempt }
}

/** The pane-transport registry is keyed by pane id; the bag is deliberately untyped. */
function setPaneTransports(session: ConnectPanePtySession, transports: Map<string, unknown>): void {
  ;(session.deps as unknown as { paneTransportsRef: { current: unknown } }).paneTransportsRef = {
    current: transports
  }
}

async function driveReattach(
  session: ConnectPanePtySession,
  result: PtyConnectResult | undefined,
  staleSessionId = 'pty-old'
): Promise<void> {
  vi.mocked(session.transport.connect).mockResolvedValue(result)
  await startDeferredSessionReattach(session, staleSessionId)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
})

describe('selected reattach operation recovery settle', () => {
  it('reports success only after the selected payload finishes', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    let finish = () => {}
    mocks.apply.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const operation = driveReattach(session, { id: 'pty-1', isReattach: true })
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalled())
    expect(settlePaneAttachAttempt).not.toHaveBeenCalled()
    finish()
    await operation
    expect(settlePaneAttachAttempt).toHaveBeenCalledWith('success')
  })

  it('does not report success for a reattach that returned no PTY id', async () => {
    // Settling this as success would clear the ledger the cold restore is about
    // to replace, and the chain would restart.
    const { session, settlePaneAttachAttempt } = buildSession({
      transport: {
        connect: vi.fn(),
        getPtyId: () => null,
        disconnect: vi.fn(),
        serializeBuffer: vi.fn()
      }
    })
    setPaneTransports(session, new Map([['pane-1', session.transport]]))

    await driveReattach(session, undefined)

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith('success')
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
  })

  it('does not report success for an expired session', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    await driveReattach(session, { id: 'pty-1', sessionExpired: true }, 'pty-old')

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith('success')
  })

  it('does not report success for a superseded transport', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()
    setPaneTransports(session, new Map())

    await driveReattach(session, { id: 'pty-1', isReattach: true })

    expect(settlePaneAttachAttempt).not.toHaveBeenCalled()
  })
})
