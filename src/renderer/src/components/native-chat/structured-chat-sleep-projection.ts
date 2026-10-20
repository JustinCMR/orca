import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '@/store'

export function useStructuredChatSleepProjection(
  tab: { id: string; entityId: string },
  target: RuntimeClientTarget | null
): void {
  const feed = useMemo(
    () => (target ? getStructuredAgentSessionStatusFeed(target) : null),
    [target]
  )
  const sleptAt = useSyncExternalStore(
    feed?.subscribe ?? (() => () => {}),
    () => (feed ? feed.getSessionSleepState(tab.entityId) : null),
    () => undefined
  )
  const observation = useSyncExternalStore(
    feed?.subscribe ?? (() => () => {}),
    () => feed?.getSessionObservation(tab.entityId) ?? 'unverifiable',
    () => 'unverifiable'
  )
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  useEffect(() => {
    const store = useAppStore.getState()
    // A failed connection resolves unknown rows, but cannot replace the host's last answer.
    if (
      feed &&
      observation === 'unverifiable' &&
      store.structuredChatSleptAtByPaneKey[paneKey] !== undefined
    ) {
      return
    }
    if (sleptAt !== undefined) {
      store.setStructuredChatSleptAt(paneKey, sleptAt)
    }
  }, [paneKey, sleptAt, feed, observation])
  useEffect(
    () => () => useAppStore.getState().setStructuredChatSleptAt(paneKey, undefined),
    [paneKey, feed]
  )
}
