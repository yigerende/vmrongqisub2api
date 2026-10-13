/** Bound SSE buffering when a caller reads slowly or disconnects mid-drain. */
export async function writeStreamChunk(res, chunk) {
  if (!chunk || res.destroyed || res.writableEnded) return
  if (res.write(chunk) !== false) return
  await new Promise((resolve, reject) => {
    const clear = () => {
      res.off('drain', done)
      res.off('close', done)
      res.off('error', fail)
    }
    const done = () => {
      clear()
      resolve()
    }
    const fail = (error) => {
      clear()
      reject(error)
    }
    res.once('drain', done)
    res.once('close', done)
    res.once('error', fail)
    if (res.destroyed || res.writableEnded) done()
  })
}
