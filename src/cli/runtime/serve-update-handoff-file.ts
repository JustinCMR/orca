/** The serve update handoff file the supervisor and its served child coordinate through. */
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {
  parseServeUpdateHandoffState,
  type ServeUpdateHandoffState
} from '../../shared/serve-update-handoff'
import type { InstallRequestedHandoff } from './serve-supervisor-policy'

export async function readServeUpdateHandoff(
  handoffPath: string
): Promise<ServeUpdateHandoffState | null> {
  try {
    return parseServeUpdateHandoffState(JSON.parse(await readFile(handoffPath, 'utf8')))
  } catch {
    return null
  }
}

export function readServeUpdateHandoffSync(handoffPath: string): ServeUpdateHandoffState | null {
  try {
    return parseServeUpdateHandoffState(JSON.parse(readFileSync(handoffPath, 'utf8')))
  } catch {
    return null
  }
}

export async function completeServeUpdateHandoff(
  handoffPath: string,
  state: InstallRequestedHandoff,
  runtimeId: string
): Promise<void> {
  await writeServeUpdateHandoffState(handoffPath, {
    ...state,
    phase: 'completed',
    runtimeId
  })
  await unlink(handoffPath).catch(() => undefined)
}

export async function recordServeUpdateHandoffFailure(
  handoffPath: string,
  state: Extract<ServeUpdateHandoffState, { phase: 'install-requested' }>,
  reason: string
): Promise<void> {
  const failedState: ServeUpdateHandoffState = { ...state, phase: 'failed', reason }
  await writeServeUpdateHandoffState(handoffPath, failedState)
  process.stderr.write(`[serve] update handoff failed: ${reason}\n`)
}

async function writeServeUpdateHandoffState(
  handoffPath: string,
  state: ServeUpdateHandoffState
): Promise<void> {
  const temporaryPath = `${handoffPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 })
  await rename(temporaryPath, handoffPath)
}
