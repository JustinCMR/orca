import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { keepDroppedCopiesInLocalChatStore } from './native-chat-drop-copy-keep'

let root: string
let copyRoot: string
let store: AgentSessionAttachmentStore

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-drop-keep-')))
  copyRoot = join(root, 'orca-drops-501')
  store = new AgentSessionAttachmentStore(join(root, 'agent-session-attachments'), {
    hasSession: () => false
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('keepDroppedCopiesInLocalChatStore', () => {
  it("moves a drag-temp copy into the chat store and leaves the user's own files in place", async () => {
    const copyDir = join(copyRoot, 'orca-drop-Ab12Cd')
    await mkdir(copyDir, { recursive: true })
    await writeFile(join(copyDir, 'shot.png'), 'png')
    const ownFile = join(root, 'Desktop', 'notes.png')
    await mkdir(join(root, 'Desktop'))
    await writeFile(ownFile, 'mine')

    const kept = await keepDroppedCopiesInLocalChatStore(
      [join(copyDir, 'shot.png'), ownFile],
      copyRoot,
      async () => store
    )

    expect(kept[0].startsWith(store.rootDir)).toBe(true)
    expect(await readFile(kept[0], 'utf8')).toBe('png')
    expect(existsSync(copyDir)).toBe(false)
    expect(kept[1]).toBe(ownFile)
    expect(await readFile(ownFile, 'utf8')).toBe('mine')
  })

  it('keeps every path as it came when the chat store is unavailable', async () => {
    const copyDir = join(copyRoot, 'orca-drop-Ab12Cd')
    await mkdir(copyDir, { recursive: true })
    await writeFile(join(copyDir, 'shot.png'), 'png')

    await expect(
      keepDroppedCopiesInLocalChatStore([join(copyDir, 'shot.png')], copyRoot, async () => null)
    ).resolves.toEqual([join(copyDir, 'shot.png')])
    expect(existsSync(join(copyDir, 'shot.png'))).toBe(true)
  })
})
