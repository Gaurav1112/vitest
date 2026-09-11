import type { WorkerGlobalState } from '../../types/worker'
import { serializeValue } from '@vitest/utils/serialize'

// Store globals in case tests overwrite them
const processListeners = process.listeners.bind(process)
const processOn = process.on.bind(process)
const processOff = process.off.bind(process)
const processExit = process.exit.bind(process)

const dispose: (() => void)[] = []

export function listenForErrors(state: () => WorkerGlobalState): void {
  dispose.forEach(fn => fn())
  dispose.length = 0

  function catchError(err: any, type: string, event: 'uncaughtException' | 'unhandledRejection') {
    const worker = state()

    const listeners = processListeners(event as 'uncaughtException')
    // if there is another listener, assume that it's handled by user code
    // one is Vitest's own listener
    if (listeners.length > 1) {
      return
    }

    const error = serializeValue(err)

    if (typeof error === 'object' && error != null) {
      error.VITEST_TEST_NAME = worker.current?.type === 'test' ? worker.current.name : undefined
      if (worker.filepath) {
        error.VITEST_TEST_PATH = worker.filepath
      }
    }
    // when the IPC channel to the main process is dead (a forks worker
    // orphaned by a main process that died without pool teardown), the
    // report would reject, come right back here as an unhandled rejection
    // and loop forever until OOM — exit the worker instead
    if (process.connected === false) {
      processExit(1)
      return
    }

    state().rpc.onUnhandledError(error, type).catch((rpcError: any) => {
      // the rejection must not float back into this handler; exit when the
      // channel is dead, there is no way to report the error anymore
      if (
        process.connected === false
        || rpcError?.code === 'ERR_IPC_CHANNEL_CLOSED'
        || rpcError?.code === 'EPIPE'
      ) {
        processExit(1)
      }
    })
  }

  const uncaughtException = (e: Error) => catchError(e, 'Uncaught Exception', 'uncaughtException')
  const unhandledRejection = (e: Error) => catchError(e, 'Unhandled Rejection', 'unhandledRejection')

  processOn('uncaughtException', uncaughtException)
  processOn('unhandledRejection', unhandledRejection)

  dispose.push(() => {
    processOff('uncaughtException', uncaughtException)
    processOff('unhandledRejection', unhandledRejection)
  })
}
