import { parentPort, workerData } from 'node:worker_threads'
import { fakeStreamKernel } from './fake-stream-kernel.mjs'

const upstream = await fakeStreamKernel(workerData.root, workerData.options)
parentPort.postMessage({ socketPath: upstream.socketPath, tokenPath: upstream.tokenPath })
parentPort.on('message', (message) => {
  if (message === 'stats') parentPort.postMessage(upstream.stats)
})
