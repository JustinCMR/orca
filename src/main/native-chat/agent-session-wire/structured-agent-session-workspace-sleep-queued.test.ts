import { expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

it.each(['send-now', 'automatic'] as const)(
  'clears Sleep only when a queued draft is submitted: %s',
  async (mode) => {
    const rig = await createQueuedMessageTestRig({ restartable: true })
    try {
      await rig.workingSend()
      const draft = rig.send('queued draft', 'queue-if-active')
      expect(await draft.result).toMatchObject({
        ok: true,
        value: { queued: { state: 'waiting' } }
      })
      expect(await rig.host.sleepWorkspace('workspace-1', true)).toEqual({
        stoppedSessionIds: [SESSION]
      })
      const sleptAt = rig.store.getRecord(SESSION)?.sleptAt
      expect(sleptAt).toEqual(expect.any(Number))
      await rig.host.history({ sessionId: SESSION, direction: 'tail' })
      expect(rig.store.getRecord(SESSION)?.sleptAt).toBe(sleptAt)
      const release = rig.holdNextStart()
      try {
        expect(await (mode === 'send-now' ? rig.sendNow(draft.id) : rig.resume())).toMatchObject({
          ok: true
        })
        await eventually(() => expect(rig.store.getRecord(SESSION)?.sleptAt).toBeUndefined())
        expect(await rig.handoff(draft.id)).toBeDefined()
      } finally {
        release()
      }
    } finally {
      await rig.dispose()
    }
  }
)
