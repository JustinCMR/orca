import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  call,
  hostCalls,
  installStructuredHostStub,
  clearStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)
it('restores readable chats before publishing the first status snapshot', async () => {
  let finish = () => {}
  const restoring = new Promise<void>((resolve) => {
    finish = resolve
  })
  const response = call('agentSession.subscribeStatus', null, STRUCTURED_CLIENT, {
    restoreStructuredAgentSessionTabs: () => restoring
  })
  await vi.waitFor(() => expect(hostCalls.subscribeStatus).not.toHaveBeenCalled())
  finish()
  expect(await response).toMatchObject({ ok: true })
  expect(hostCalls.subscribeStatus).toHaveBeenCalledOnce()
})
