import type { WorkerGlobalState } from '../../../packages/vitest/src/types/worker'
import { afterEach, expect, test, vi } from 'vitest'

// The worker's `catchError` reports uncaught errors to the main process with a
// fire-and-forget rpc call. When the IPC channel is dead (a forks worker
// orphaned by a main process that died without pool teardown), that report
// rejects, comes back to `catchError` as an unhandled rejection and loops
// forever until OOM (#11241). These tests drive `listenForErrors` directly
// with a rejecting rpc and assert the worker exits instead of looping.

afterEach(() => {
  vi.restoreAllMocks()
})

// this test file runs in a live worker, so `process.connected` can only be
// overridden for the duration of a synchronous call — a fake value would
// trip the worker's own dead-channel guards otherwise
function withConnected(value: boolean, fn: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'connected')
  Object.defineProperty(process, 'connected', {
    value,
    configurable: true,
    writable: true,
  })
  try {
    fn()
  }
  finally {
    if (descriptor) {
      Object.defineProperty(process, 'connected', descriptor)
    }
    else {
      delete (process as { connected?: boolean }).connected
    }
  }
}

async function setup(onUnhandledError: () => Promise<void>) {
  const handlers: Record<string, (error: Error) => unknown> = {}

  // capture the handlers instead of registering them on the real process, so
  // the emulated events don't interfere with the worker running this test
  vi.spyOn(process, 'on').mockImplementation((event, handler) => {
    handlers[event as string] = handler as (error: Error) => unknown
    return process
  })
  vi.spyOn(process, 'off').mockImplementation(() => process)
  // catchError bails out when it sees more than one listener, assuming user
  // code handles the event — report exactly one, Vitest's own
  vi.spyOn(process, 'listeners').mockReturnValue([() => {}])
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never)

  const report = vi.fn(onUnhandledError)
  const state = () =>
    ({ rpc: { onUnhandledError: report } } as unknown as WorkerGlobalState)

  // the module binds the process globals at evaluation time, so it has to be
  // imported freshly after the spies above are installed
  vi.resetModules()
  const { listenForErrors } = await import(
    '../../../packages/vitest/src/runtime/moduleRunner/errorCatcher.js',
  )
  listenForErrors(state)

  return { handlers, exit, report }
}

test('worker exits instead of reporting when the IPC channel is known dead', async () => {
  const { handlers, exit, report } = await setup(() => Promise.resolve())

  withConnected(false, () => {
    handlers.unhandledRejection(new Error('orphaned worker error'))
  })

  expect(exit).toHaveBeenCalledWith(1)
  // the report must not be attempted at all — on a dead channel its rejection
  // would loop right back into catchError
  expect(report).not.toHaveBeenCalled()
})

test('worker exits when the report rejects because the IPC channel closed', async () => {
  const { handlers, exit } = await setup(() =>
    Promise.reject(
      Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }),
    ),
  )

  handlers.uncaughtException(new Error('orphaned worker error'))

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
})

test('rejected report without an IPC error code is handled without exiting', async () => {
  const { handlers, exit, report } = await setup(() =>
    Promise.reject(new Error('serialization failed')),
  )

  handlers.unhandledRejection(new Error('some test error'))

  // if the rejection were left floating, it would re-enter catchError as
  // another unhandled rejection and fail this test file
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(exit).not.toHaveBeenCalled()
})
