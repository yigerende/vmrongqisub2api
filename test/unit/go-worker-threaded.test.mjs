// Reuse the transport contract suite against the production thread dispatcher:
// Claude and Responses, tools, usage trailers, errors and cancellation must
// match the original inline implementation byte for byte.
import { after } from 'node:test'
import { startStreamWorkers, streamWorkerPool } from '../../src/lib/transport/stream-workers.mjs'
import { cancelWorkerRequest } from '../../src/lib/transport/go-worker-client.mjs'

await startStreamWorkers({ size: 2, cancel: cancelWorkerRequest })
after(() => streamWorkerPool().close())
await import('./go-worker-client.test.mjs')
