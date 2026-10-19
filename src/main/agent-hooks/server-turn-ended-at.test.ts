import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// The execution host marks each real turn end: a new turn (by the agent's turn id, or a prompt) or a
// verified re-entered Stop is a new end, and every restatement of a finished turn keeps the old one.
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

  it('ends Codex turns by turn id, with or without a prompt hook in between', async () => {
    const codex = (payload: Record<string, unknown>) => post(payload, '/hook/codex')
    await codex({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-a', prompt: 'Plan it' })
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    const first = row()?.turnEndedAt
    expect(first).toEqual(expect.any(Number))

    // The same turn's duplicate Stop, and a tool reopen of it, restate its end.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    await codex({ hook_event_name: 'PreToolUse', turn_id: 'turn-a', tool_name: 'Bash' })
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Planned.' })
    expect(row()).toMatchObject({ state: 'done', turnEndedAt: first })

    // A turn woken by agent mail runs no prompt hook and stays `done`; its own turn id ends it.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-b', last_assistant_message: 'Replied.' })
    const mailTurn = row()?.turnEndedAt
    expect(mailTurn).toBeGreaterThan(first!)

    // Codex re-fires Stop with the flag when a blocking Stop hook continues the same turn.
    await codex({ hook_event_name: 'Stop', turn_id: 'turn-b', stop_hook_active: true })
    expect(row()?.turnEndedAt).toBeGreaterThan(mailTurn!)
    expect(row()).not.toHaveProperty('hostTurn')
  })

  it('ends identical Command Code prompts at new transcript positions as new turns', async () => {
    const transcriptPath = join(directory, 'command-code.jsonl')
    const prompt = `${JSON.stringify({ role: 'user', content: 'Status?' })}\n`
    const stop = { hook_event_name: 'Stop', transcript_path: transcriptPath }
    writeFileSync(transcriptPath, prompt)
    await post(stop, '/hook/command-code')
    const first = row()?.turnEndedAt
    expect(first).toEqual(expect.any(Number))
    await post(stop, '/hook/command-code')
    expect(row()?.turnEndedAt).toBe(first)

    writeFileSync(transcriptPath, prompt.repeat(2))
    await post(stop, '/hook/command-code')
    expect(row()?.turnEndedAt).toBeGreaterThan(first!)
  })

  it('restates the end when a result retry adds the late transcript text', async () => {
    const transcriptPath = join(directory, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }, '/hook/copilot')
    // The Stop's text isn't flushed yet; its retry re-reads the same Stop body. Copilot's own
    // re-entry flag is unverified, so it restates like any repeat.
    const stop = { hook_event_name: 'Stop', stop_hook_active: true }
    await post({ ...stop, transcript_path: transcriptPath }, '/hook/copilot')
    const ended = row()?.turnEndedAt
    expect(ended).toEqual(expect.any(Number))
    await post({ ...stop, transcript_path: transcriptPath }, '/hook/copilot')
    expect(row()?.turnEndedAt).toBe(ended)

    const line = { type: 'assistant.message', data: { content: 'Tests pass.' } }
    writeFileSync(transcriptPath, `${JSON.stringify(line)}\n`)
    await vi.waitFor(() => expect(row()?.lastAssistantMessage).toBe('Tests pass.'))
    expect(row()?.turnEndedAt).toBe(ended)
  })

  it('reaches the live push and survives a host restart, so a restatement stays the same end', async () => {
    const pushed: (number | undefined)[] = []
    server.setListener((status) => pushed.push(status.turnEndedAt))
    const stop = { hook_event_name: 'Stop', turn_id: 'turn-a', last_assistant_message: 'Done.' }
    await post(stop, '/hook/codex')
    const ended = row()?.turnEndedAt
    expect(pushed.at(-1)).toBe(ended)
    server.flushStatusPersistSync()
    server.stop()

    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: directory })
    expect(row()).toMatchObject({ turnEndedAt: ended })
    // The saved turn record still knows turn-a ended, through a working reopen too.
    await post(
      { hook_event_name: 'PreToolUse', turn_id: 'turn-a', tool_name: 'Bash' },
      '/hook/codex'
    )
    await post(stop, '/hook/codex')
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
