import { DRAG_TEMP_COPY_ROOT_NAME } from '../../../../shared/native-file-drop'

/** Whether a dropped path may be a macOS drag-temp copy; main checks the real path. */
function mayBeDragTempCopy(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment.startsWith(DRAG_TEMP_COPY_ROOT_NAME))
}

/** A local structured chat's drag-temp copies, moved into this machine's chat store so the send
 *  that names one claims it. Anything else, or a move that fails, keeps its path. */
export async function keepLocalChatDropCopies<T extends { path: string }>(
  entries: readonly T[]
): Promise<T[]> {
  if (!entries.some(({ path }) => mayBeDragTempCopy(path))) {
    return [...entries]
  }
  try {
    const kept = await window.api.fs.keepDroppedCopiesInLocalChatStore(
      entries.map(({ path }) => path)
    )
    return entries.map((entry, index) =>
      typeof kept[index] === 'string' ? { ...entry, path: kept[index] } : entry
    )
  } catch {
    return [...entries]
  }
}
