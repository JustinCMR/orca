// Why apart from the terminal sleep marker: that marker ignores wakes while teardown runs,
// but the user's latest open or Sleep must decide whether an earlier Sleep may hide chats.
const currentAttemptByWorkspaceId = new Map<string, symbol>()

/** A newer explicit Sleep of the same workspace replaces the older one. */
export function beginChatSleepAttempt(workspaceId: string): symbol {
  const attempt = Symbol(workspaceId)
  currentAttemptByWorkspaceId.set(workspaceId, attempt)
  return attempt
}

export function supersedeChatSleepAttempt(workspaceId: string): void {
  currentAttemptByWorkspaceId.delete(workspaceId)
}

export function isCurrentChatSleepAttempt(workspaceId: string, attempt: symbol): boolean {
  return currentAttemptByWorkspaceId.get(workspaceId) === attempt
}

export function endChatSleepAttempt(workspaceId: string, attempt: symbol): void {
  if (isCurrentChatSleepAttempt(workspaceId, attempt)) {
    currentAttemptByWorkspaceId.delete(workspaceId)
  }
}
