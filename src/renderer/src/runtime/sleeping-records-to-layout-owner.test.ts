import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'
import { followSleepingRecordsInLayoutOwner } from './sleeping-records-to-layout-owner'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: unknown }) => ({
      ok: true,
      result: {}
    })
  )
}))
const held: { store?: ReturnType<typeof createTestStore> } = {}
vi.mock('@/store', () => ({
  get useAppStore() {
    return held.store
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const LOCAL = 'repo1::/path/wt'
const PAIRED = 'repo2::/remote/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PANE = `${TAB}:11111111-1111-4111-8111-111111111111`
const PAIRED_TAB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const PAIRED_PANE = `${PAIRED_TAB}:22222222-2222-4222-8222-222222222222`

function record(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

function terminalRow(id: string, worktreeId: string) {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function setRecords(records: Record<string, SleepingAgentSessionRecord>): void {
  held.store!.setState({ sleepingAgentSessionsByPaneKey: records })
}

const sent = () => mocks.callRuntimeRpc.mock.calls.map((call) => call[2].command)

beforeAll(() => {
  const store = createTestStore()
  seedStore(
    store,
    runtimeOwnedRepoState('env-1', 'repo2', '/remote', {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: LOCAL, repoId: 'repo1', path: '/path/wt' })],
        repo2: [makeRuntimeOwnedWorktree({ id: PAIRED, repoId: 'repo2' }, 'env-1')]
      },
      tabsByWorktree: {
        [LOCAL]: [terminalRow(TAB, LOCAL)],
        [PAIRED]: [terminalRow(PAIRED_TAB, PAIRED)]
      },
      // Restore's records are main's own.
      sleepingAgentSessionsByPaneKey: { [PANE]: { ...record(PANE, LOCAL), state: 'done' } }
    })
  )
  held.store = store
})

beforeEach(() => {
  mocks.callRuntimeRpc.mockClear()
})

describe('main’s copy of the window’s resume records', () => {
  it('sends nothing for the records restore loaded, and subscribes once', () => {
    followSleepingRecordsInLayoutOwner()
    followSleepingRecordsInLayoutOwner()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    setRecords({})
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('records an added record without stopping its pane, and a dropped one without starting it', () => {
    const live = record(PANE, LOCAL)
    setRecords({ [PANE]: live })
    setRecords({})

    expect(sent()).toEqual([
      {
        type: 'sleep',
        workspace: LOCAL,
        tabId: TAB,
        paneKeys: [PANE],
        records: [live],
        recordOnly: true
      },
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE], recordOnly: true }
    ])
  })

  it('sends nothing for a paired server’s workspace', () => {
    setRecords({ [PAIRED_PANE]: record(PAIRED_PANE, PAIRED) })
    setRecords({})

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a resumed pane’s real wake before the record drop that follows it', () => {
    setRecords({ [PANE]: record(PANE, LOCAL) })
    mocks.callRuntimeRpc.mockClear()

    held.store!.getState().clearSleepingAgentSession(PANE, {
      paneKey: PANE,
      tabId: TAB,
      paneId: 1,
      worktreeId: LOCAL,
      record: record(PANE, LOCAL),
      wake: true
    })

    expect(sent()).toEqual([
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE] },
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE], recordOnly: true }
    ])
  })

  it.each(['codex', 'pi'] as const)(
    'selects current %s identity and removes aliases before subscriber recapture',
    (agent) => {
      const store = held.store!
      const old = { ...record(PANE, LOCAL), agent }
      const alias = `${TAB}:1`
      const other = {
        ...old,
        providerSession: {
          ...old.providerSession,
          id: agent === 'codex' ? 'successor' : old.providerSession.id,
          transcriptPath: '/new-transcript'
        }
      }
      const expected = {
        paneKey: PANE,
        tabId: TAB,
        paneId: 1,
        worktreeId: LOCAL,
        record: old,
        wake: true as const
      }
      setRecords({ [PANE]: other, [alias]: { ...old, paneKey: alias } })
      mocks.callRuntimeRpc.mockClear()
      expect(store.getState().clearSleepingAgentSession(alias, expected)).toBe('superseded')
      expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
      setRecords({ [PANE]: { ...old, updatedAt: 9 }, [alias]: { ...old, paneKey: alias } })
      const recipe = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      store.getState().registerAgentLaunchConfig(PANE, recipe)
      store.getState().registerAgentLaunchConfig(alias, recipe)
      const seen: number[] = []
      const unsubscribe = store.subscribe((state, previous) => {
        if (state.sleepingAgentSessionsByPaneKey === previous.sleepingAgentSessionsByPaneKey) {
          return
        }
        if (!state.sleepingAgentSessionsByPaneKey[PANE]) {
          seen.push(
            Object.keys(state.agentLaunchConfigByPaneKey).filter(
              (key) => key === PANE || key === alias
            ).length
          )
          store.setState({ sleepingAgentSessionsByPaneKey: { [PANE]: other } })
        }
      })
      expect(store.getState().clearSleepingAgentSession(alias, expected)).toBe('superseded')
      unsubscribe()
      expect(seen).toEqual([0])
      expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toBe(other)
      expect(store.getState().sleepingAgentSessionsByPaneKey[alias]).toBeUndefined()
    }
  )
})
