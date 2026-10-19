import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const PANE_KEY = makePaneKey('tab-1', LEAF_1)
const SEA = "The sea's waves carry the endless rhythm of tides."

type TimelineEvent =
  | { at: number; title: string; bell?: true }
  | { at: number; hook: 'working' | 'done'; message?: string; restated?: true }

// Recorded from Claude Code 2.1.280 over a real PTY (ms from launch): one prompt, then a
// `/btw` side question 45 s later. The side question spins the title and fires no hook.
// The BEL beside the idle title is the burst agents commonly emit at a turn end.
const SIDE_QUESTION: TimelineEvent[] = [
  { at: 0, title: '✳ Claude Code' },
  { at: 3_416, hook: 'working' },
  { at: 3_686, title: '◐ Claude Code' },
  { at: 4_647, title: '◑ Claude Code' },
  { at: 7_050, title: '◑ The sea' },
  { at: 7_552, title: '◐ The sea' },
  { at: 8_447, hook: 'done', message: SEA },
  { at: 8_760, title: '✳ The sea', bell: true },
  { at: 53_328, title: '◑ The sea' },
  { at: 54_299, title: '◐ The sea' },
  { at: 55_146, title: '✳ The sea' }
]

// A blocking Stop hook: Stop #1 lands, Claude continues text-only (title keeps spinning, no
// hook), then Stop #2 re-enters with the final message and the title goes idle ~90 ms later.
// A minute on, a session reset clears the message cache and an idle reminder restates the turn.
const BLOCKED_STOP: TimelineEvent[] = [
  { at: 0, title: '✳ Claude Code' },
  { at: 1_000, hook: 'working' },
  { at: 1_200, title: '◐ Claude Code' },
  { at: 5_000, hook: 'done', message: 'Draft answer.' },
  { at: 6_000, title: '◑ Claude Code' },
  { at: 12_000, hook: 'done', message: 'Final answer.' },
  { at: 12_090, title: '✳ Claude Code' },
  { at: 72_000, hook: 'done', restated: true }
]

describe('Claude completion banners through the real pane and hook lanes', () => {
  let mockStoreState: StoreState
  let transportQueue: MockTransport[] = []
  let transportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []
  let foreground: string | null = 'claude'

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportQueue = []
    transportOptions = []
    storeSubscribers = []
    foreground = 'claude'
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportQueue,
      getTransportOptions: () => transportOptions,
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
    vi.useFakeTimers()
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
    vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => foreground !== null)
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function play(timeline: TimelineEvent[], servedBy?: string): Promise<void> {
    const { dispatchTerminalNotification } = await import('./use-notification-dispatch')
    const { observeAgentHookCompletionForNotification } =
      await import('@/hooks/agent-hook-completion-notifications')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async () => null)
    transportQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' },
      dispatchNotification: (event: Parameters<typeof dispatchTerminalNotification>[1]) =>
        dispatchTerminalNotification('wt-1', event)
    })
    await connectMockPanePty(createPane(1), createManager(1), deps)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks(20)
    if (servedBy) {
      // A pane of a paired server that predates the turn-end stamp (it advertises no capability).
      const ptyId = `remote:${servedBy}@@pty-1`
      mockStoreState.ptyIdsByTabId['tab-1'] = [ptyId]
      mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = { [LEAF_1]: ptyId }
      mockStoreState.runtimeStatusByEnvironmentId.set(servedBy, { status: { capabilities: [] } })
    }

    // Stand in for the transport's title tracker: every title, plus its working/idle edge.
    const transportHandler = (name: string) => {
      const handler: unknown = transportOptions[0]?.[name]
      if (typeof handler !== 'function') {
        throw new Error(`Expected the pane to register ${name}`)
      }
      return handler
    }
    let working = false
    let elapsed = 0
    let doneStartedAt: number | undefined
    let turnEndedAt: number | undefined
    for (const event of timeline) {
      await vi.advanceTimersByTimeAsync(event.at - elapsed)
      elapsed = event.at
      if ('title' in event) {
        transportHandler('onTitleChange')(event.title, event.title)
        const nowWorking = !event.title.startsWith('✳')
        if (nowWorking !== working) {
          transportHandler(nowWorking ? 'onAgentBecameWorking' : 'onAgentBecameIdle')(event.title)
        }
        working = nowWorking
        if (event.bell) {
          transportHandler('onBell')()
        }
        continue
      }
      // The host pins `stateStartedAt` while the state stays `done`, and stamps each real Stop.
      const stateStartedAt =
        event.hook === 'done' ? (doneStartedAt ??= Date.now()) : (doneStartedAt = undefined)
      turnEndedAt = event.hook !== 'done' ? undefined : event.restated ? turnEndedAt : Date.now()
      const payload: AgentCompletionStatusSnapshot = {
        state: event.hook,
        prompt: 'Reply with one short sentence.',
        agentType: 'claude',
        ...(event.message ? { lastAssistantMessage: event.message } : {}),
        stateStartedAt: stateStartedAt ?? Date.now(),
        ...(turnEndedAt !== undefined ? { turnEndedAt } : {})
      }
      mockStoreState.agentStatusByPaneKey[PANE_KEY] = {
        ...payload,
        paneKey: PANE_KEY,
        updatedAt: Date.now(),
        stateHistory: []
      }
      observeAgentHookCompletionForNotification({ paneKey: PANE_KEY, worktreeId: 'wt-1', payload })
    }
    await vi.advanceTimersByTimeAsync(5_000)
  }

  const banners = () =>
    vi.mocked(window.api.notifications.dispatch).mock.calls.map(([request]) => request)

  it('announces the turn once with its last message; a /btw, its BEL and quitting stay quiet', async () => {
    await play(SIDE_QUESTION)
    foreground = null
    await vi.advanceTimersByTimeAsync(15_000)

    expect(banners()).toEqual([
      expect.objectContaining({
        source: 'agent-task-complete',
        agentType: 'claude',
        agentLastAssistantMessage: SEA
      })
    ])
    expect(mockStoreState.markAgentAttentionUnread).toHaveBeenCalledTimes(1)
  })

  it('keeps the title banner for a /btw on a pane whose paired server predates the stamp', async () => {
    await play(SIDE_QUESTION, 'old-server')

    expect(banners().at(-1)).toEqual(
      expect.objectContaining({ source: 'agent-task-complete', terminalTitle: '✳ The sea' })
    )
    expect(banners().at(-1)).not.toHaveProperty('agentLastAssistantMessage')
  })

  it('announces each Stop of a blocking Stop hook turn once, and not its later restatement', async () => {
    await play(BLOCKED_STOP)

    expect(banners()).toEqual([
      expect.objectContaining({
        source: 'agent-task-complete',
        agentLastAssistantMessage: 'Draft answer.'
      }),
      expect.objectContaining({
        source: 'agent-task-complete',
        agentLastAssistantMessage: 'Final answer.'
      })
    ])
  })
})
