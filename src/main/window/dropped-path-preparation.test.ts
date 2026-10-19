import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import {
  createDragTempCopyLane,
  createDroppedPathPreparationQueue,
  MAX_PENDING_DRAG_TEMP_COPIES
} from './dropped-path-preparation'

const materialize = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('./dragged-temp-file-copy', async (original) => ({
  ...(await original<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materialize
}))
const TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_one', 'Shot.png')
const ORDINARY = join('/', 'files', 'notes.txt')
const COPY = join('/', 'var', 'T', 'orca-drops', 'orca-drop-abc123', 'Shot.png')
const env = { platform: 'darwin' as const, sourceTempRoot: '/var/T', copyRoot: '/var/T/drops' }

function queue(lane = createDragTempCopyLane(), copyTimeoutMs = 1000) {
  const controller = new AbortController()
  const dispose = vi.fn()
  const enqueue = createDroppedPathPreparationQueue(
    {
      platform: 'darwin',
      getCopyEnvironment: async () => env,
      watchRenderer: () => ({ signal: controller.signal, dispose }),
      copyTimeoutMs
    },
    lane
  )
  return {
    enqueue: async (request: Parameters<typeof enqueue>[0]) => enqueue(request),
    controller,
    dispose
  }
}
function deferred<T = DragTempCopyItemResult[]>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
beforeEach(() => {
  materialize.mockReset()
})

async function realDrop() {
  const root = await mkdtemp(join(tmpdir(), 'orca-30419-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sourceTempRoot = join(root, 'T')
  const source = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_test', 'shot.png')
  await mkdir(join(source, '..'), { recursive: true })
  await writeFile(source, 'image')
  const actual = await vi.importActual<typeof DragTempFileCopy>('./dragged-temp-file-copy')
  materialize.mockImplementation(actual.materializeDragTempPaths)
  return {
    source,
    env: { platform: 'darwin' as const, sourceTempRoot, copyRoot: join(root, 'drops') },
    store: new AgentSessionAttachmentStore(join(root, 'store'), { hasSession: () => false })
  }
}

describe('dropped path preparation through the shared copy queue', () => {
  it('hands off fresh duplicates, preserves reused copies and abandons late writes without blocking the queue', async () => {
    const { source, env, store } = await realDrop()
    const getStore = vi.fn(async (): Promise<AgentSessionAttachmentStore | null> => store)
    const write = vi.spyOn(store, 'storeFile')
    const enqueue = createDroppedPathPreparationQueue({
      platform: 'darwin',
      copyTimeoutMs: 1000,
      watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() }),
      getCopyEnvironment: async () => env,
      localChatAttachmentStore: getStore
    })
    write.mockRejectedValueOnce(new Error('disk'))
    const fallback = await enqueue({ paths: [source], consumer: 'local-chat' })
    const reused = fallback.paths[0]
    expect(await readFile(reused, 'utf8')).toBe('image')
    const sibling = join(reused, '..', 'notes.txt')
    await writeFile(sibling, 'keep')
    const result = await enqueue({ paths: [source, source, reused], consumer: 'local-chat' })
    expect(result.paths[0]).toBe(result.paths[1])
    expect(await readFile(result.paths[0], 'utf8')).toBe('image')
    expect(result.paths[0].startsWith(store.rootDir)).toBe(true)
    expect(result.paths[2]).toBe(reused)
    expect(await readFile(reused, 'utf8')).toBe('image')
    expect(await readFile(sibling, 'utf8')).toBe('keep')
    expect(write).toHaveBeenCalledTimes(2)
    expect(await readdir(env.copyRoot)).toHaveLength(1)
    getStore.mockResolvedValueOnce(null)
    const unavailable = await enqueue({ paths: [source], consumer: 'local-chat' })
    expect(await readFile(unavailable.paths[0], 'utf8')).toBe('image')
    const started = deferred<void>()
    const release = deferred<string>()
    const completed = deferred<string>()
    onTestFinished(() => release.resolve('abandoned'))
    write.mockImplementationOnce(async (name, bytes) => {
      started.resolve()
      await release.promise
      const stored = await AgentSessionAttachmentStore.prototype.storeFile.call(store, name, bytes)
      completed.resolve(stored)
      return stored
    })
    const abandoned = enqueue({ paths: [source], consumer: 'local-chat' })
    await started.promise
    const next = enqueue({ paths: [source], consumer: 'agent' })
    await expect(abandoned).resolves.toMatchObject({
      paths: [],
      failures: [{ commonReason: 'timed-out' }]
    })
    const following = await next
    await vi.waitFor(async () => expect(await readdir(env.copyRoot)).toHaveLength(3))
    expect(await readFile(following.paths[0], 'utf8')).toBe('image')
    release.resolve('continue')
    expect(await readFile(await completed.promise, 'utf8')).toBe('image')
    await settle()
    await expect(abandoned).resolves.toMatchObject({ paths: [] })
    expect(await readdir(env.copyRoot)).toHaveLength(3)
  })

  it.each(['agent', 'main-reader'] as const)(
    'passes ordinary paths without copying for %s',
    async (consumer) => {
      const { enqueue } = queue()
      await expect(enqueue({ paths: [ORDINARY], consumer })).resolves.toEqual({
        paths: [ORDINARY],
        failures: []
      })
      expect(materialize).not.toHaveBeenCalled()
    }
  )

  it.each(['agent', 'main-reader'] as const)(
    'withholds uncopied originals only from agents: %s',
    async (consumer) => {
      materialize.mockResolvedValue([
        { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
        { sourcePath: TEMP, status: 'uncopied', reason: 'storage-full' }
      ])
      const { enqueue } = queue()
      const result = await enqueue({ paths: [ORDINARY, TEMP], consumer })
      expect(result.paths).toEqual(consumer === 'agent' ? [ORDINARY] : [ORDINARY, TEMP])
      expect(result.failures).toEqual(
        consumer === 'agent'
          ? [
              {
                byteLength: 0,
                pathCount: 1,
                reason: 'temp-copy-failed',
                target: 'rejected',
                commonReason: 'storage-full'
              }
            ]
          : []
      )
    }
  )

  it('preserves ordinary successes and copied successes when another file fails', async () => {
    materialize.mockResolvedValue([
      { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
      { sourcePath: TEMP, status: 'imported', destPath: COPY },
      { sourcePath: TEMP, status: 'failed', reason: 'missing' }
    ])
    const result = await queue().enqueue({
      paths: [ORDINARY, TEMP, TEMP],
      consumer: 'agent'
    })
    expect(result.paths).toEqual([ORDINARY, COPY])
    expect(result.failures[0]).toMatchObject({ pathCount: 1, commonReason: 'missing' })
  })

  it('serializes copy requests from different owners', async () => {
    const first = deferred()
    materialize
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue()
    const chat = enqueue({ paths: [TEMP], consumer: 'agent' })
    const editor = enqueue({ paths: [TEMP], consumer: 'main-reader' })
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    first.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(chat).resolves.toEqual({ paths: [COPY], failures: [] })
    await expect(editor).resolves.toEqual({ paths: [COPY], failures: [] })
    expect(materialize).toHaveBeenCalledTimes(2)
  })

  it('shares serialization and the pending cap across replacement-window queues', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const lane = createDragTempCopyLane()
    const first = queue(lane)
    const second = queue(lane)
    const results = Array.from({ length: MAX_PENDING_DRAG_TEMP_COPIES }, () =>
      first.enqueue({ paths: [TEMP], consumer: 'agent' }).catch(() => undefined)
    )
    await expect(
      second.enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    ).resolves.toMatchObject({ paths: [ORDINARY], failures: [{ commonReason: 'busy' }] })
    first.controller.abort(new Error('test ended'))
    await Promise.all(results)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('lets another owner prepare ordinary paths while a copy waits', async () => {
    const copy = deferred()
    materialize.mockReturnValueOnce(copy.promise)
    const { enqueue } = queue()
    const pending = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(enqueue({ paths: [ORDINARY], consumer: 'main-reader' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: []
    })
    copy.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await pending
  })

  it('aborts running and queued requests on reload and releases their listeners', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const { enqueue, controller, dispose } = queue()
    const running = enqueue({ paths: [TEMP], consumer: 'agent' })
    const queued = enqueue({ paths: [TEMP], consumer: 'agent' })
    const assertions = [
      expect(running).rejects.toThrow('reloaded'),
      expect(queued).rejects.toThrow('reloaded')
    ]
    await settle()
    controller.abort(new Error('reloaded'))
    await Promise.all(assertions)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('reports timeout, keeps ordinary paths, and serves the next copy', async () => {
    materialize
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue(undefined, 5)
    const first = enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    const next = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(first).resolves.toMatchObject({
      paths: [ORDINARY],
      failures: [{ commonReason: 'timed-out' }]
    })
    await expect(next).resolves.toEqual({ paths: [COPY], failures: [] })
  })
  it('passes drag-temp-looking paths unchanged on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const enqueue = createDroppedPathPreparationQueue({
        platform,
        getCopyEnvironment: async () => env,
        watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
      })
      expect(enqueue({ paths: [TEMP], consumer: 'agent' })).toEqual({ paths: [TEMP], failures: [] })
    }
    expect(materialize).not.toHaveBeenCalled()
  })

  it('reports all lost paths without a shared reason when their failures differ', async () => {
    materialize.mockResolvedValue([
      { sourcePath: TEMP, status: 'failed', reason: 'missing' },
      { sourcePath: TEMP, status: 'failed', reason: 'changed' }
    ])
    await expect(queue().enqueue({ paths: [TEMP, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [],
      failures: [{ byteLength: 0, pathCount: 2, reason: 'temp-copy-failed', target: 'rejected' }]
    })
  })

  it('keeps ordinary paths and serves the next drop when the copy environment fails', async () => {
    const getCopyEnvironment = vi.fn(async () => env)
    getCopyEnvironment.mockRejectedValueOnce(new Error('no temp path'))
    const enqueue = createDroppedPathPreparationQueue({
      platform: 'darwin',
      getCopyEnvironment,
      watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
    })
    await expect(enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: [{ byteLength: 0, pathCount: 1, reason: 'temp-copy-failed', target: 'rejected' }]
    })
    materialize.mockResolvedValue([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(enqueue({ paths: [TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [COPY],
      failures: []
    })
  })
})
