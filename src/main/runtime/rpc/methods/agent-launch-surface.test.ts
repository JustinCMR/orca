import '../unused-default-rpc-methods.test-fixture'
/**
 * `agent.launch`'s `surface`: the user's chat-or-terminal pick for one launch. A terminal pick runs
 * the CLI whatever the setting says; a chat pick this host can prove it cannot open is refused
 * before anything is created, and a retry answers with the same refusal.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../../../shared/agent-launch-surface'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import {
  methodNamed,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const CREATE_IN_SUBFOLDER = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
  cwd: 'packages/app',
  surface: 'chat'
}

describe("agent.launch's surface pick", () => {
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ee`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-surface-'))
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await rm(directory, { recursive: true, force: true })
  })

  function replay(runtime: AgentLaunchRuntimeStub, launch: Record<string, unknown>) {
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    return dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'agent.launchReplay',
      params: AGENT_LAUNCH_REPLAY.params.parse({ ...launch, operationId: OPERATION_ID })
    })
  }

  it('refuses a chat it cannot open before creating anything, and a retry says the same', async () => {
    const runtime = runtimeStub({ settings: {} })

    const response = await replay(runtime, CREATE_IN_SUBFOLDER)

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE,
        message: expect.stringContaining("Claude can't open as a chat here")
      }
    })
    expect(store.listOperationRows()[0]?.outcome).toMatchObject({
      status: 'failed',
      code: AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE
    })
    expect(await replay(runtime, CREATE_IN_SUBFOLDER)).toMatchObject(response)
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('starts the CLI for a terminal pick even when chats are the default', async () => {
    const runtime = runtimeStub({ settings: { experimentalNativeChat: true } })

    const response = await replay(runtime, {
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-7' },
      surface: 'terminal'
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        outcome: { kind: 'terminal' },
        receipt: { mode: 'terminal', reason: 'requested' }
      }
    })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:wt-7',
      expect.objectContaining({ startupAgent: 'claude' })
    )
  })
})
