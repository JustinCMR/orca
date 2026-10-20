// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'

const initialState = useAppStore.getInitialState()

describe('useVisibleWorkspaceKanbanWorktreeIds', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('keeps a single-host filter host-qualified when workspace ids collide', () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const repo = makeRepo()
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [local, ssh] },
      showSleepingWorkspaces: true,
      visibleWorkspaceHostIds: ['local']
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [local, ssh],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(new Set([getWorktreeHostIdentity(local)]))
  })

  it.each([undefined, null, 1])(
    'shows a chat workspace only with awake host evidence: %s',
    (sleptAt) => {
      const worktree = makeWorktree('chat', 'Chat workspace')
      const repo = makeRepo()
      const structuredTab: Tab = {
        id: 'chat-tab',
        entityId: 'chat-session',
        groupId: 'chat-group',
        worktreeId: worktree.id,
        contentType: 'agent-session',
        agentSessionAgent: 'codex',
        label: 'Chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
      useAppStore.setState({
        worktreesByRepo: { [repo.id]: [worktree] },
        unifiedTabsByWorktree: { [worktree.id]: [structuredTab] },
        structuredChatSleptAtByPaneKey:
          sleptAt === undefined
            ? {}
            : {
                [structuredAgentSessionPaneKey(structuredTab.id, structuredTab.entityId)]: sleptAt
              },
        showSleepingWorkspaces: false
      })

      const { result } = renderHook(() =>
        useVisibleWorkspaceKanbanWorktreeIds({
          allWorktrees: [worktree],
          repoMap: new Map([[repo.id, repo]])
        })
      )

      expect(result.current).toEqual(
        new Set(sleptAt === null ? [getWorktreeHostIdentity(worktree)] : [])
      )
    }
  )
})
