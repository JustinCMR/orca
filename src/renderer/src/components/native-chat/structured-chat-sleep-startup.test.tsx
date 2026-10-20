// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type { Tab } from '../../../../shared/tab-types'
import { getWorktreeIdsWithStructuredChat } from '../sidebar/visible-worktree-activity-inputs'
import { selectIsSleepingWorktree } from '../sidebar/use-worktree-sleep-state'
import { hasSleepableWorkspaceActivity } from '../sidebar/workspace-lineage-menu-actions'
const mocks = vi.hoisted(() => ({ subscribeStatus: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
import { useAppStore } from '@/store'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
const structuredTab: Tab = {
  id: 'chat-tab',
  entityId: 'session-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
function summary(overrides: Partial<AgentSessionStatusSummary>): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'idle',
    latestPrompt: '',
    updatedAt: 1,
    ...overrides
  }
}
function feed(index = 0): { emit: (event: AgentSessionStatusEvent) => void } {
  return { emit: mocks.subscribeStatus.mock.calls[index][1] }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: vi.fn() })
  mocks.supportsCapability.mockResolvedValue(true)
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
})
describe('restored chat workspace Sleep', () => {
  it.each(['slept', 'awake', 'disconnected', 'old-host', 'absent'] as const)(
    'waits for host sleep evidence after restart: %s',
    async (answer) => {
      if (answer === 'old-host') {
        mocks.supportsCapability.mockResolvedValue(false)
      }
      const local = answer !== 'old-host'
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [{ ...structuredTab, executionHostId: local ? 'local' : 'runtime:old' }]
        },
        structuredChatSleptAtByPaneKey: {},
        agentStatusByPaneKey: {},
        tabsByWorktree: {},
        browserTabsByWorktree: {}
      })
      const visible = () => {
        const state = useAppStore.getState()
        return getWorktreeIdsWithStructuredChat(
          state.unifiedTabsByWorktree,
          state.structuredChatSleptAtByPaneKey
        ).has('wt-1')
      }
      expect(visible()).toBe(false)
      expect(selectIsSleepingWorktree(useAppStore.getState(), 'wt-1')).toBe(false)
      expect(hasSleepableWorkspaceActivity('wt-1', useAppStore.getState())).toBe(false)
      render(<StructuredAgentSessionStatusBridge />)
      if (answer === 'old-host') {
        await waitFor(() => expect(visible()).toBe(true))
        expect(mocks.subscribeStatus).not.toHaveBeenCalled()
        return
      }
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
      expect(visible()).toBe(false)
      act(() =>
        feed().emit(
          answer === 'disconnected'
            ? { type: 'end' }
            : {
                type: 'snapshot',
                sessions:
                  answer === 'absent'
                    ? []
                    : [
                        summary({
                          hostExecutionOwned: undefined,
                          sleptAt: answer === 'slept' ? 5 : undefined
                        })
                      ]
              }
        )
      )
      if (answer === 'slept') {
        act(() => feed().emit({ type: 'end' }))
        expect(visible()).toBe(false)
      }
      expect(visible()).toBe(answer !== 'slept')
      expect(selectIsSleepingWorktree(useAppStore.getState(), 'wt-1')).toBe(answer === 'slept')
      expect(hasSleepableWorkspaceActivity('wt-1', useAppStore.getState())).toBe(answer !== 'slept')
      if (answer === 'slept') {
        await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
        act(() => feed(1).emit({ type: 'status', session: summary({}) }))
        expect(visible()).toBe(true)
      }
    }
  )
})
