import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session-wire'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'

/** How long one scan answers for a folder and account before the next read scans again. The list
 *  changes only when commands, skills or plugins do, and a running chat reports its own. */
export const AT_REST_COMMANDS_TTL_MS = 5 * 60_000
/** A failed scan is due again this soon, so one failure doesn't hide the list for the whole TTL. */
const FAILED_SCAN_RETRY_MS = 10_000
/** A scan still unanswered this long no longer holds the next one off, so a hung folder can't
 *  freeze the menu. At most two run at once, so a folder that stays hung holds no more. */
const SCAN_OVERDUE_MS = 30_000
const MAX_SCANS_IN_FLIGHT = 2
/** How long a client's own `/` read waits for a running scan. Phones ask once per menu and never
 *  hear a later change; well inside their request timeout. */
export const AT_REST_COMMANDS_READ_BUDGET_MS = 10_000

/** One scan's answer. `fromAgent` is the agent's own list, which a fallback never replaces;
 *  `commands` undefined means the agent has no list to give here. */
export type AtRestCommandScan = {
  commands: AgentSessionSlashCommand[] | undefined
  fromAgent: boolean
}

export type AtRestCommandSource = {
  /** Only records this host can scan for: another host's folders are only readable there. */
  accepts: (record: AgentSessionRecord) => boolean
  /** The folder the agent will launch in, and what it lists there. */
  scan: (record: AgentSessionRecord, cwd: string) => Promise<AtRestCommandScan>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  label: string
  now?: () => number
}

type Entry = {
  commands?: AgentSessionSlashCommand[]
  fromAgent?: boolean
  /** When the kept answer, or the last failure, landed; a failure lands as an older answer. */
  scannedAt: number
  lastStartedAt: number
  inFlight: number
  /** Numbers each scan, so only an answer newer than the one kept replaces it. */
  started: number
  kept: number
  settled: Set<() => void>
}

/** The folder a record's agent launches in: a floating chat's pin, otherwise its workspace's. */
function pinnedFolder(record: AgentSessionRecord): string | null {
  return agentSessionPinnedLaunchDirectory(record) ?? null
}

/**
 * The `/` surface of a chat whose agent is not running, as its source lists it on the host that
 * runs it, in the folder the chat launches in. Nothing until the first scan lands; `onChange`
 * fires when a scan finds something different.
 */
export class AtRestCommandCatalog implements StructuredAgentSessionAtRestCommands {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly source: AtRestCommandSource) {}

  read = (record: AgentSessionRecord): AgentSessionSlashCommand[] | undefined => {
    const entry = this.entry(record)
    if (!entry) {
      return undefined
    }
    const now = this.now()
    const due =
      entry.inFlight === 0
        ? now - entry.scannedAt >= AT_REST_COMMANDS_TTL_MS
        : entry.inFlight < MAX_SCANS_IN_FLIGHT && now - entry.lastStartedAt >= SCAN_OVERDUE_MS
    if (due) {
      this.scanInto(entry, record)
    }
    return entry.commands
  }

  /** The kept answer once no scan for this record is running, or when `budgetMs` ends. */
  settled = (record: AgentSessionRecord, budgetMs: number): Promise<void> => {
    const entry = this.entry(record)
    if (!entry || entry.inFlight === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        entry.settled.delete(done)
        resolve()
      }
      const timer = setTimeout(done, budgetMs)
      entry.settled.add(done)
    })
  }

  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Why the pin and the account: two floating chats pinned to different folders, or one folder
  // under two accounts, list different skills.
  private entry(record: AgentSessionRecord): Entry | undefined {
    if (!this.source.accepts(record)) {
      return undefined
    }
    const key = JSON.stringify([
      record.provider,
      requireLegacyAgentSessionAccountHome(record.accountHome).path,
      record.location.workspaceId,
      pinnedFolder(record)
    ])
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        scannedAt: Number.NEGATIVE_INFINITY,
        lastStartedAt: Number.NEGATIVE_INFINITY,
        inFlight: 0,
        started: 0,
        kept: 0,
        settled: new Set()
      }
      this.entries.set(key, entry)
    }
    return entry
  }

  private scanInto(entry: Entry, record: AgentSessionRecord): void {
    const scan = ++entry.started
    entry.lastStartedAt = this.now()
    entry.inFlight += 1
    const newest = (fromAgent: boolean): boolean => {
      if (scan < entry.kept) {
        return false
      }
      entry.scannedAt = this.now()
      // A rejected fallback still settles the refresh, but cannot supersede the agent's list.
      if (entry.fromAgent && !fromAgent) {
        return false
      }
      entry.kept = scan
      return true
    }
    void this.scan(record)
      .then(
        ({ commands, fromAgent }) => {
          if (!newest(fromAgent)) {
            return
          }
          entry.fromAgent = fromAgent
          if (JSON.stringify(commands) === JSON.stringify(entry.commands)) {
            return
          }
          entry.commands = commands
          for (const listener of this.listeners) {
            listener()
          }
        },
        (error: unknown) => {
          // Due again after the retry delay, leaving room for an older scan's answer meanwhile.
          entry.scannedAt = this.now() - AT_REST_COMMANDS_TTL_MS + FAILED_SCAN_RETRY_MS
          console.warn(`[${this.source.label}] reading the at-rest \`/\` commands failed:`, error)
        }
      )
      .finally(() => {
        entry.inFlight -= 1
        if (entry.inFlight === 0) {
          for (const done of entry.settled) {
            done()
          }
        }
      })
  }

  private async scan(record: AgentSessionRecord): Promise<AtRestCommandScan> {
    const cwd =
      pinnedFolder(record) ?? (await this.source.resolveWorkspacePath(record.location.workspaceId))
    return this.source.scan(record, cwd)
  }

  private now(): number {
    return this.source.now?.() ?? Date.now()
  }
}
