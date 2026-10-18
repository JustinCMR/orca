import { launchProbe } from '../../../../shared/launch-probe'
import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    launchProbe('main-spawn-enter', args.tabId ?? 'none', { cols: args.cols, rows: args.rows })
    const startupPromise = getLocalPtyStartupPromise(
      getConnectionExecutionHostId(args.connectionId)
    )
    if (startupPromise) {
      await startupPromise
    }
    launchProbe('main-startup-ready', args.tabId ?? 'none')
    const probeResult = await runPtyIpcSpawn(deps, args)
    launchProbe('main-spawn-done', args.tabId ?? 'none', { id: (probeResult as { id?: string } | null)?.id })
    return probeResult
  })
}
