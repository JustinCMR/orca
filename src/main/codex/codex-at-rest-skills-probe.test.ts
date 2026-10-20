// A Codex chat whose Codex is not running lists what Codex itself would load in the folder the
// chat launches in, from one short-lived app-server that answers at once and then settles.

import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { CodexAppServerInvocation } from './codex-app-server-session'
import { createCodexAtRestSkillCatalog } from './codex-at-rest-skills-probe'

function floatingCodexChat(sessionId: string, launchDirectory: string) {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/me/.codex' },
    launchDirectory,
    location: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  })
}

describe('a resting Codex chat lists the skills Codex would load', () => {
  it('answers per pinned folder before the probe settles, which then ends the whole tree', async () => {
    const invocations: CodexAppServerInvocation[] = []
    const settling: (() => void)[] = []
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body({
          request: async (_method, params) => {
            const cwds = params?.cwds
            const cwd = Array.isArray(cwds) ? String(cwds[0]) : ''
            const name = cwd.endsWith('one') ? 'first' : 'second'
            return { data: [{ cwd, skills: [{ name, path: `${cwd}/${name}/SKILL.md` }] }] }
          },
          notify: () => {}
        })
      }
    })
    const one = floatingCodexChat('one', '/work/one')
    const two = floatingCodexChat('two', '/work/two')

    expect(catalog.read(one)).toBeUndefined()
    expect(catalog.read(two)).toBeUndefined()
    await Promise.all([catalog.settled(one, 1_000), catalog.settled(two, 1_000)])

    // Both answered while their probes still settle: two folders, two lists.
    expect(settling).toHaveLength(2)
    expect(catalog.read(one)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'first', kind: 'skill', path: '/work/one/first/SKILL.md' }
    ])
    expect(catalog.read(two)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'second', kind: 'skill', path: '/work/two/second/SKILL.md' }
    ])
    // Plugins stay on, or Codex lists no plugin skill; the finish kills the tree while it lives.
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      expect.not.arrayContaining(['features.plugins=false']),
      expect.not.arrayContaining(['features.plugins=false'])
    ])
    expect(invocations.every((invocation) => invocation.treeKillOnFinish)).toBe(true)
    expect(invocations[0]?.env).toMatchObject({ CODEX_HOME: '/home/me/.codex' })
    settling.forEach((resolve) => resolve())
  })
})
