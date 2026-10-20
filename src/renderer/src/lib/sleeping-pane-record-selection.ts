import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

export type SleepingPaneSelection = {
  paneKey: string
  tabId: string
  paneId: number
  worktreeId: string
}

export type SleepingRecordConsumption = SleepingPaneSelection & {
  record: SleepingAgentSessionRecord
  wake?: true
}

export type SleepingRecordDisposition = 'accepted' | 'absent' | 'superseded'

export function selectSleepingRecordForPane(
  records: Record<string, SleepingAgentSessionRecord>,
  { paneKey: cacheKey, tabId, paneId, worktreeId }: SleepingPaneSelection
): { paneKey: string; record: SleepingAgentSessionRecord } | 'ambiguous' | null {
  const stableRecord = records[cacheKey]
  if (stableRecord) {
    return { paneKey: cacheKey, record: stableRecord }
  }
  const legacyMatches = Object.entries(records).filter(([paneKey, record]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return (
      legacy?.tabId === tabId &&
      record.worktreeId === worktreeId &&
      (!record.tabId || record.tabId === tabId)
    )
  })
  const exactLegacyMatch = legacyMatches.find(([paneKey]) => {
    const legacy = parseLegacyNumericPaneKey(paneKey)
    return legacy?.numericPaneId === String(paneId)
  })
  const oldestFirst = legacyMatches.sort(
    ([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt
  )
  const first = oldestFirst[0]
  // Numeric aliases without an exact pane match must all identify the same session.
  const selectedLegacyMatch =
    exactLegacyMatch ??
    (first &&
    oldestFirst.every(
      ([, record]) => getProviderSessionClaimKey(record) === getProviderSessionClaimKey(first[1])
    )
      ? first
      : null)
  if (!selectedLegacyMatch) {
    return legacyMatches.length ? 'ambiguous' : null
  }
  const [paneKey, record] = selectedLegacyMatch
  return { paneKey, record }
}
