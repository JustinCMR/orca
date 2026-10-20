import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../shared/agent-launch-surface'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** Raised only by the launch-mode preflight, which runs before any workspace or surface exists,
 *  so a launch that throws it had no effects and its replay answers with the same words. */
export class AgentLaunchSurfaceUnavailableError extends OrchestrationError {
  constructor(message: string) {
    super(AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE, message)
  }
}
