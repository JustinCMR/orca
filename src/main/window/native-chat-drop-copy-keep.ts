// A local structured chat's dropped drag-temp copies move into this machine's chat attachment
// store, where the send that names one claims it for that chat. Every other path comes back as it
// came, and a copy that cannot move stays where it was: the drop is never refused for this.

import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, ipcMain } from 'electron'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../shared/native-file-drop'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { dragTempCopyDirectoryOf, getDragTempCopyRoot } from './dragged-temp-file-copy'

type LocalChatAttachmentStore = () => Promise<AgentSessionAttachmentStore | null>

export async function keepDroppedCopiesInLocalChatStore(
  paths: unknown,
  copyRoot: string,
  localChatAttachmentStore: LocalChatAttachmentStore
): Promise<string[]> {
  if (!Array.isArray(paths)) {
    return []
  }
  const named = paths
    .slice(0, NATIVE_FILE_DROP_MAX_PATHS)
    .filter((path): path is string => typeof path === 'string')
  const realRoot = await realpath(copyRoot).catch(() => null)
  const store = realRoot ? await localChatAttachmentStore().catch(() => null) : null
  if (!realRoot || !store) {
    return named
  }
  const kept: string[] = []
  for (const path of named) {
    kept.push(await keepDroppedCopy(path, realRoot, store))
  }
  return kept
}

async function keepDroppedCopy(
  path: string,
  realRoot: string,
  store: AgentSessionAttachmentStore
): Promise<string> {
  try {
    const real = await realpath(path)
    const copyDir = dragTempCopyDirectoryOf(realRoot, real)
    const info = copyDir ? await stat(real) : null
    if (!copyDir || !info?.isFile() || info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      return path
    }
    const stored = await store.storeFile(basename(real), await readFile(real))
    await rm(copyDir, { recursive: true, force: true }).catch(() => undefined)
    return stored
  } catch (error) {
    console.warn('[drop] a dropped copy stays in drop storage:', error)
    return path
  }
}

export function registerNativeChatDropCopyKeep(
  localChatAttachmentStore: LocalChatAttachmentStore
): void {
  ipcMain.removeHandler('fs:keepDroppedCopiesInLocalChatStore')
  ipcMain.handle('fs:keepDroppedCopiesInLocalChatStore', (_event, paths: unknown) =>
    keepDroppedCopiesInLocalChatStore(
      paths,
      getDragTempCopyRoot(app.getPath('temp')),
      localChatAttachmentStore
    )
  )
}
