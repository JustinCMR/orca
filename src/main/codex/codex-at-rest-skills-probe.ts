import { PrioritySemaphore } from '../../shared/priority-semaphore'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { runCodexAppServerSession } from './codex-app-server-session'
import { isCodexSkillsListUnsupported, requestCodexSkillReport } from './codex-skill-list'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'

/** How long Codex has to answer `skills/list`. */
const ANSWER_TIMEOUT_MS = 15_000
/** How long a probe lives after it spawns. Plugins on, Codex starts its plugin sync and marketplace
 *  upgrades at startup (two git steps, 30 s each); killed before they finish, they leave their
 *  staging folders in CODEX_HOME for good and the next start clones again. */
export const CODEX_SKILLS_PROBE_SETTLE_MS = 70_000
/** Each probe starts a Codex process, so many folders opening at once wait their turn. */
const MAX_PROBES_ANSWERING = 2

export type CodexAtRestSkillsDeps = CodexStructuredInvocationDeps & {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** The sync a launch runs on this home first, so the probe reads what a launch would. */
  prepareHome?: (home: string) => void
  now?: () => number
  /** Test seams. */
  runSession?: typeof runCodexAppServerSession
  sleep?: (ms: number) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * Codex's own skills for the folder a resting Codex chat launches in, from one short-lived
 * app-server with plugins on (plugin skills exist only then). It answers as soon as Codex lists
 * them, then lives out the settle time so Codex's own startup work ends normally.
 */
export function createCodexAtRestSkillCatalog(deps: CodexAtRestSkillsDeps): AtRestCommandCatalog {
  const answering = new PrioritySemaphore(MAX_PROBES_ANSWERING)
  return new AtRestCommandCatalog({
    label: 'codex',
    accepts: (record) =>
      record.provider === 'codex' &&
      supportsCodexStructuredLocation(record.location) &&
      isLegacyAgentSessionAccountHome(record.accountHome),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    scan: async (record, cwd) => {
      const acquired = await answering.acquire(0)
      let released = false
      const release = (): void => {
        if (!released) {
          released = true
          acquired()
        }
      }
      try {
        return await probeCodexSkills(deps, record, cwd, release)
      } finally {
        release()
      }
    },
    ...(deps.now ? { now: deps.now } : {})
  })
}

async function probeCodexSkills(
  deps: CodexAtRestSkillsDeps,
  record: AgentSessionRecord,
  cwd: string,
  releaseSlot: () => void
): Promise<AtRestCommandScan> {
  const accountHomePath = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const { command, environment } = await resolveCodexStructuredInvocation(deps)
  deps.prepareHome?.(accountHomePath)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepFor
  const spawnedAt = now()
  let answer!: (scan: AtRestCommandScan) => void
  let fail!: (error: unknown) => void
  const answered = new Promise<AtRestCommandScan>((resolve, reject) => {
    answer = resolve
    fail = reject
  })
  void (deps.runSession ?? runCodexAppServerSession)(
    {
      command,
      args: [...CODEX_READ_ONLY_APP_SERVER_ARGS],
      cliPath: command,
      env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
      timeoutMs: CODEX_SKILLS_PROBE_SETTLE_MS + ANSWER_TIMEOUT_MS,
      treeKillOnFinish: true
    },
    async (rpc) => {
      try {
        answer({
          commands: await requestCodexSkillReport(rpc, cwd, { timeoutMs: ANSWER_TIMEOUT_MS }),
          fromAgent: true
        })
      } catch (error) {
        if (!isCodexSkillsListUnsupported(error)) {
          fail(error)
          return
        }
        // An older Codex has no list to give; the client keeps its folder scan.
        answer({ commands: undefined, fromAgent: true })
      }
      // Settling holds a process, not a slot: the next folder may start answering now.
      releaseSlot()
      await sleep(spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now())
    }
  ).catch(fail)
  return answered
}
