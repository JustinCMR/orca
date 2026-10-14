import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import {
  dispatchTerminalNotification,
  resetAnnouncedHookEvidenceForTest
} from './use-notification-dispatch'
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
    resetAnnouncedHookEvidenceForTest()
    delete mockState.agentStatusByPaneKey[PANE_KEY]
  })

  afterEach(() => {
    setPresenceGated(true)
    vi.unstubAllGlobals()
  })

  it("announces the turn end with the agent's last message and stays quiet for a /btw side question", () => {
    // The pane lane reads titles only; Claude's hook rows land in the store.
    const coordinator = createAgentCompletionCoordinator({
      paneKey: PANE_KEY,
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      isLive: () => true,
      dispatchCompletion: (title) =>
        dispatchTerminalNotification('wt-primary', {
          source: 'agent-task-complete',
          terminalTitle: title,
          paneKey: PANE_KEY
        })
    })
    const launchedAt = Date.now()
    for (const event of CAPTURE) {
      vi.setSystemTime(launchedAt + event.at)
      if ('title' in event) {
        coordinator.observeTitle(event.title)
      } else {
        mockState.agentStatusByPaneKey[PANE_KEY] = makeAgentStatus(PANE_KEY, {
          agentType: 'claude',
          prompt: 'Reply with one short sentence about the sea.',
          ...(event.hook === 'Stop'
            ? { state: 'done', lastAssistantMessage: SEA }
            : { state: 'working', lastAssistantMessage: undefined })
        })
      }
    }

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalTitle: '✳ The sea',
        agentType: 'claude',
        agentState: 'done',
        agentLastAssistantMessage: SEA
      })
    )
    expect(mockState.markAgentAttentionUnread).toHaveBeenCalledTimes(1)
  })
})
