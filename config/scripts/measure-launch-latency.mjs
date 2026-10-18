// Measurement-only harness (agent-start-latency lane); never merged.
// Drives "+" > <agent> in a running test copy over CDP and collects the app's own
// [launch-probe] marks (window.__orcaLaunchProbe). No coordinate clicks, no focus.
//
// node config/scripts/measure-launch-latency.mjs --port 9420 --agent claude --runs 5 \
//   --label mac-hidden-claude --out results.jsonl [--screenshot-dir dir] [--warmup 0]
import { chromium } from 'playwright-core'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1]?.startsWith('--') ? '1' : all[i + 1]])
    return acc
  }, [])
)
const port = Number(args.port)
const agent = args.agent ?? 'claude'
const runs = Number(args.runs ?? 5)
const label = args.label ?? `${process.platform}-${agent}`
const out = args.out ?? 'launch-latency.jsonl'
const shotDir = args['screenshot-dir']
const timeoutMs = Number(args.timeout ?? 45000)
const quietMs = Number(args.quiet ?? 1500)
const menuLabel = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', terminal: 'New Terminal' }[agent] ?? agent
// Text each agent paints once its input box is up (from captured transcripts; tune per version).
const readyPattern = {
  // Local: input-box text only; the banner paints before the input is live.
  claude: /\? for shortcuts|Try "|bypass permissions on/i,
  codex: /Ask Codex|\? for shortcuts|send\s+\S*\s*newline|context left/i,
  opencode: /ctrl\+p|tab\s+agents|opencode\s+v?\d|ctrl\+x/i,
  // Local addition: plain-terminal baseline is ready at the zsh prompt.
  terminal: /% *$/m
}[agent]

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => !p.url().startsWith('devtools://') && p.url().includes('index.html'))
if (!page) throw new Error('renderer page not found')
const identity = await page.evaluate(async () => {
  try {
    return await window.api.app.getIdentity()
  } catch {
    return null
  }
})
console.log('identity', JSON.stringify(identity))

async function frameRate() {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0
        const start = performance.now()
        const tick = () => {
          n += 1
          if (performance.now() - start < 1000) requestAnimationFrame(tick)
          else resolve({ frames: n, ms: Math.round(performance.now() - start), vis: document.visibilityState })
        }
        requestAnimationFrame(tick)
        setTimeout(() => resolve({ frames: n, ms: Math.round(performance.now() - start), vis: document.visibilityState, timedOut: true }), 3000)
      })
  )
}

async function clickAgent() {
  await page.getByRole('button', { name: 'New tab' }).first().click({ timeout: 10000 })
  const byTitle = page.locator(`[role="menuitem"][title="Launch ${menuLabel} in a new terminal"]`).first()
  const item = (await byTitle.count()) > 0 ? byTitle : page.getByRole('menuitem', { name: menuLabel, exact: agent !== 'terminal' }).first()
  await item.waitFor({ state: 'visible', timeout: 10000 })
  const t0 = await page.evaluate(() => performance.timeOrigin + performance.now())
  await item.click({ timeout: 10000 })
  return t0
}

for (let run = 1; run <= runs; run += 1) {
  const fps = await frameRate()
  await page.evaluate(() => {
    globalThis.__orcaLaunchProbe = []
  })
  const t0 = await clickAgent()
  const started = Date.now()
  let probes = []
  let tabId = null
  let readyAt = null
  let readyScreen = null
  let lastDataAt = null
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(100)
    probes = await page.evaluate(() => globalThis.__orcaLaunchProbe ?? [])
    // Local addition: plain terminals skip launchAgentInNewTab, so fall back to the first new pane's tab.
    tabId = tabId ?? probes.find((p) => p.step === 'tab-created')?.key ?? (agent === 'terminal' ? probes.find((p) => p.step === 'pane-connect')?.key : null) ?? null
    const data = probes.filter((p) => p.step === 'data' && (!tabId || p.key === tabId))
    if (data.length > 0) lastDataAt = data[data.length - 1].at
    if (readyAt === null && tabId) {
      // Local harness fix: data probes truncate each chunk to 100 chars, so match the
      // rendered screen instead and attribute readiness to the newest chunk that preceded it.
      const screen = await page.evaluate((id) => {
        const manager = window.__paneManagers?.get(id)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        if (!pane) return null
        const buffer = pane.terminal.buffer.active
        const rows = []
        for (let row = 0; row < pane.terminal.rows; row += 1) {
          rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
        }
        return { type: buffer.type, text: rows.join('\n') }
      }, tabId)
      if (screen && readyPattern?.test(screen.text) && data.length > 0) {
        readyAt = data[data.length - 1].at
        readyScreen = screen
      }
    }
    const now = await page.evaluate(() => performance.timeOrigin + performance.now())
    if (readyAt !== null && lastDataAt !== null && now - lastDataAt > quietMs) break
  }
  const rel = (step) => {
    const p = probes.find((x) => x.step === step && (x.key === tabId || x.key === 'global'))
    return p ? Math.round(p.at - t0) : null
  }
  const firstData = probes.find((p) => p.step === 'data' && p.key === tabId)
  const settleEnd = probes.find((p) => p.step === 'settle-end' && p.key === tabId)
  const row = {
    label,
    agent,
    run,
    t0Epoch: t0,
    platform: process.platform,
    fps,
    tabId,
    ms: {
      click: rel('click'),
      tabCreated: rel('tab-created'),
      paneConnect: rel('pane-connect'),
      connectScheduled: rel('connect-scheduled'),
      deferredConnectRun: rel('deferred-connect-run'),
      settleStart: rel('settle-start'),
      settleEnd: rel('settle-end'),
      connectStart: rel('connect-start'),
      transportConnect: rel('transport-connect'),
      spawnResolved: rel('spawn-resolved'),
      connected: rel('connected'),
      firstData: firstData ? Math.round(firstData.at - t0) : null,
      agentReady: readyAt === null ? null : Math.round(readyAt - t0),
      lastData: lastDataAt === null ? null : Math.round(lastDataAt - t0)
    },
    readyScreen,
    settle: settleEnd ? { frames: settleEnd.frames, sizes: settleEnd.sizes } : null,
    dataText: probes
      .filter((p) => p.step === 'data' && p.key === tabId)
      .slice(0, 25)
      .map((p) => `${Math.round(p.at - t0)}:${p.text}`),
    probes: probes.filter((p) => p.key === tabId || p.key === 'global').map((p) => ({ ...p, at: Math.round(p.at - t0) }))
  }
  appendFileSync(out, `${JSON.stringify(row)}\n`)
  console.log(label, run, JSON.stringify(row.ms), JSON.stringify(row.settle), JSON.stringify(fps))
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true })
    await page.screenshot({ path: join(shotDir, `${label}-run${run}.png`) })
  }
  if (tabId) {
    await page.evaluate((id) => window.__store.getState().closeTab(id), tabId)
  }
  await page.waitForTimeout(2000)
}
// Disconnect only; never close the app under test.
process.exit(0)
