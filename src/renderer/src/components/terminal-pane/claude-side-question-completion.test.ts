import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { dispatchTerminalNotification } from './use-notification-dispatch'
import {
  observeAgentHookCompletionForNotification,
  resetAgentHookCompletionNotificationCoordinators
} from '@/hooks/agent-hook-completion-notifications'
import { hookLaneOwnsPaneTurnEnds } from '@/hooks/agent-hook-turn-end-ownership'
import {
  PANE_KEY,
  makeAgentStatus,
  resetNotificationDispatchMockState,
  type NotificationDispatchMockState
} from './notification-dispatch-test-harness'

vi.mock('@/store', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createNotificationDispatchStoreModuleMock()
})

vi.mock('@/lib/desktop-notification-sound', async () => {
  const harness = await import('./notification-dispatch-test-harness')
  return harness.createDesktopNotificationSoundModuleMock()
})

const SEA = "The sea's waves carry the endless rhythm of tides."

// Recorded from Claude Code 2.1.280 over a real PTY (ms from launch): one prompt, then a
// `/btw` side question 45 s later. The side question spins the title and fires no hook.
const CAPTURE = [
  { at: 0, title: '✳ Claude Code' },
  { at: 3_416, hook: 'UserPromptSubmit' },
  { at: 3_686, title: '◐ Claude Code' },
  { at: 4_647, title: '◑ Claude Code' },
  { at: 7_050, title: '◑ The sea' },
  { at: 7_552, title: '◐ The sea' },
  { at: 8_447, hook: 'Stop' },
  { at: 8_760, title: '✳ The sea' },
  { at: 53_328, title: '◑ The sea' },
  { at: 54_299, title: '◐ The sea' },
  { at: 55_146, title: '✳ The sea' }
] as const

let mockState: NotificationDispatchMockState

describe('Claude completion banner', () => {
  useAgentCompletionCoordinatorLifecycle()

  beforeEach(() => {
    setPresenceGated(false)
    mockState = resetNotificationDispatchMockState()
    resetAgentHookCompletionNotificationCoordinators()
    delete mockState.agentStatusByPaneKey[PANE_KEY]
  })

  afterEach(() => {
    setPresenceGated(true)
    vi.unstubAllGlobals()
  })

  it("announces the turn end once with the agent's last message and stays quiet for a /btw side question", () => {
    // Both real lanes, wired as in the app: hooks feed the hook lane, titles feed the pane lane.
    const titleLane = createAgentCompletionCoordinator({
      paneKey: PANE_KEY,
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      isLive: () => true,
      titleCompletionOwnedByHooks: (title) => hookLaneOwnsPaneTurnEnds(PANE_KEY, title),
      dispatchCompletion: (title) =>
        dispatchTerminalNotification('wt-primary', {
          source: 'agent-task-complete',
          terminalTitle: title,
          paneKey: PANE_KEY
        })
    })
    let previousAt = 0
    for (const event of CAPTURE) {
      vi.advanceTimersByTime(event.at - previousAt)
      previousAt = event.at
      if ('title' in event) {
        titleLane.observeTitle(event.title)
        continue
      }
      const row = makeAgentStatus(PANE_KEY, {
        agentType: 'claude',
        prompt: 'Reply with one short sentence about the sea.',
        ...(event.hook === 'Stop'
          ? { state: 'done', lastAssistantMessage: SEA }
          : { state: 'working', lastAssistantMessage: undefined })
      })
      mockState.agentStatusByPaneKey[PANE_KEY] = row
      observeAgentHookCompletionForNotification({
        paneKey: PANE_KEY,
        worktreeId: 'wt-primary',
        payload: row
      })
    }
    vi.advanceTimersByTime(5_000)

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'claude', agentLastAssistantMessage: SEA })
    )
    expect(mockState.markAgentAttentionUnread).toHaveBeenCalledTimes(1)
    titleLane.dispose()
  })
})
