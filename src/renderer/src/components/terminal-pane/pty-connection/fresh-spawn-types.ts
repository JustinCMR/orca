import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'

export type PendingStartupCommand = {
  command: string
  env?: Record<string, string>
}

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  resumeProviderSession: AgentProviderSessionMetadata
  launchConfig: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}

export type PaneRestoreOutcome =
  | {
      kind: 'connected'
      ptyId: string
      generation: number
      agentResumed: boolean
      recordAcceptance?: 'accepted' | 'absent'
    }
  | { kind: 'superseded'; generation: number; ptyId?: string }
  | { kind: 'failed' | 'held' | 'ended'; generation: number }

export type ReattachResultDecision =
  | (PaneRestoreOutcome & {
      preparedStartup?: ColdRestoreAgentResumeStartup | null
      resumeUnavailable?: boolean
    })
  | { kind: 'continue-fresh' }
