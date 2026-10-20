import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('workspace Sleep routing', () => {
  it('builds the host for a marked Sleep instead of returning an unmarked fallback receipt', async () => {
    clearStructuredHostStub()
    const ensureHost = vi.fn(async () => installStructuredHostStub())
    expect(
      await call(
        'agentSession.sleepWorkspace',
        { workspaceId: 'workspace-1', markAsleep: true },
        STRUCTURED_CLIENT,
        {
          ensureStructuredAgentSessionHost: ensureHost
        }
      )
    ).toMatchObject({ ok: true })
    expect(ensureHost).toHaveBeenCalledOnce()
    expect(hostCalls.sleepWorkspace).toHaveBeenCalledWith('workspace-1', true)
  })
})
