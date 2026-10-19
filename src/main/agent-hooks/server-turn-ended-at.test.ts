import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// The execution host marks each real turn end, so a re-entered Stop is a new end and every
// restatement of a finished turn (whatever its text) keeps the old one.
describe('the host-stamped turn end', () => {
  let server: AgentHookServer
  let directory: string

  beforeEach(async () => {
    _internals.resetCachesForTests()
    directory = mkdtempSync(join(tmpdir(), 'orca-turn-ended-at-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: directory })
  })

  afterEach(() => {
    server.stop()
    rmSync(directory, { recursive: true, force: true })
  })

  async function post(payload: Record<string, unknown>, path = '/hook/claude'): Promise<void> {
    expect((await postHookEvent(server, buildBody(payload), path)).status).toBe(204)
    // Distinct host stamps: each event lands on a later millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const row = () => server.getStatusSnapshot()[0]

  it('mints a new end only for a re-entered Stop, whatever the text', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Lint the repo' })
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    const first = row()
    expect(first?.turnEndedAt).toEqual(expect.any(Number))

    // A duplicate delivery and an idle reminder restate the turn.
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    await post({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(row()).toMatchObject({ turnEndedAt: first?.turnEndedAt })

    // A blocking Stop hook made Claude continue; the same text still ends a new turn.
    await post({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Done.' })
    expect(row()?.turnEndedAt).toBeGreaterThan(first!.turnEndedAt!)
    expect(row()?.stateStartedAt).toBe(first?.stateStartedAt)

    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Again' })
    expect(row()).not.toHaveProperty('turnEndedAt')
  })

  it('keeps a Grok end across a session reset and the idle reminder that follows it', async () => {
    const turn = { sessionId: 'session-1', promptId: 'prompt-1' }
    await post({ hookEventName: 'user_prompt_submit', ...turn, prompt: 'go' }, '/hook/grok')
    await post({ hookEventName: 'stop', ...turn, lastAssistantMessage: 'Shipped.' }, '/hook/grok')
    const ended = row()?.turnEndedAt
    expect(ended).toEqual(expect.any(Number))

    await post({ hookEventName: 'session_start', sessionId: 'session-2' }, '/hook/grok')
    await post(
      { hookEventName: 'notification', sessionId: 'session-2', notificationType: 'idle_prompt' },
      '/hook/grok'
    )
    expect(row()).toMatchObject({ state: 'done', turnEndedAt: ended })
  })

  it('restates the end when a result retry adds the late transcript text', async () => {
    const transcriptPath = join(directory, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await post({ hook_event_name: 'Stop', message: 'Draft.' }, '/hook/copilot')
    const draft = row()?.turnEndedAt
    // The re-entered Stop's text isn't flushed yet; its retry re-reads the same Stop body.
    const reentered = { hook_event_name: 'Stop', stop_hook_active: true }
    await post({ ...reentered, transcript_path: transcriptPath }, '/hook/copilot')
    const ended = row()?.turnEndedAt
    expect(ended).toBeGreaterThan(draft!)

    const line = { type: 'assistant.message', data: { content: 'Tests pass.' } }
    writeFileSync(transcriptPath, `${JSON.stringify(line)}\n`)
    await vi.waitFor(() => expect(row()?.lastAssistantMessage).toBe('Tests pass.'))
    expect(row()?.turnEndedAt).toBe(ended)
  })

  it('reaches the live push and survives a host restart, so a restatement stays the same end', async () => {
    const pushed: (number | undefined)[] = []
    server.setListener((status) => pushed.push(status.turnEndedAt))
    await post({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    const ended = row()?.turnEndedAt
    expect(pushed.at(-1)).toBe(ended)
    server.flushStatusPersistSync()
    server.stop()

    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: directory })
    expect(row()).toMatchObject({ turnEndedAt: ended })
    await post({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(row()).toMatchObject({ state: 'done', turnEndedAt: ended })
  })

  it("keeps a relay's own end and never mints one for an older relay's Stop", () => {
    const stop = {
      paneKey: PANE,
      tabId: 'tab-1',
      source: 'claude' as const,
      hookEventName: 'Stop',
      payload: { state: 'done' as const, prompt: 'relayed', agentType: 'claude' as const }
    }
    server.ingestRemote(stop, 'wsl-old')
    expect(row()).not.toHaveProperty('turnEndedAt')

    server.ingestRemote({ ...stop, turnEndedAt: 42 }, 'wsl-old')
    expect(row()).toMatchObject({ turnEndedAt: 42 })
  })
})
