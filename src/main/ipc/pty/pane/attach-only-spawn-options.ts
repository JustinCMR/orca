import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'

/** Adopts `options.sessionId` only: no startup command, agent delivery or new-session claim. */
export function attachOnlySpawnOptions(options: PtySpawnOptions): PtySpawnOptions {
  if (!options.sessionId) {
    throw new SessionNotFoundError('')
  }
  return {
    ...options,
    attachOnly: true,
    isNewSession: undefined,
    command: undefined,
    commandDelivery: undefined,
    startupCommandDelivery: undefined,
    launchAgent: undefined,
    startupIngress: undefined,
    agentSessionEnsure: undefined,
    agentSessionCreateOperationId: undefined,
    onPtySpawnCommitted: undefined
  }
}
