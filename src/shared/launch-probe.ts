// Measurement-only probe (agent-start-latency lane); never merged.
export function launchProbe(step: string, key: string, extra?: Record<string, unknown>): void {
  try {
    const at = performance.timeOrigin + performance.now()
    const entry = { at, step, key, ...extra }
    const target = globalThis as Record<string, unknown>
    const list = (target.__orcaLaunchProbe ??= []) as unknown[]
    list.push(entry)
    if (list.length > 5000) {
      list.splice(0, list.length - 5000)
    }
    console.log(`[launch-probe] ${JSON.stringify(entry)}`)
  } catch {
    // probe only
  }
}
