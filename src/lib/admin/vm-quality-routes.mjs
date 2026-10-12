/** Called after panel authentication/RBAC. Quality configuration is admin-only. */
export async function handleVmQuality({ req, res, url, monitor, readBody, json }) {
  const base = '/api/panel/vm-quality'
  if (!url.pathname.startsWith(`${base}/`)) return false
  try {
    if (!monitor) throw Object.assign(new Error('检测服务未就绪'), { status: 503 })
    let data
    let status = 200
    if (url.pathname === `${base}/capabilities` && req.method === 'GET')
      data = { version: 1, max_slots: 100, read_only: true, assignment_guard: true }
    else if (url.pathname === `${base}/results` && req.method === 'POST')
      data = monitor.results((await readBody(req, 65536)).slots)
    else if (url.pathname === `${base}/settings` && req.method === 'GET') data = monitor.getConfig()
    else if (url.pathname === `${base}/settings` && req.method === 'PUT')
      data = monitor.setConfig(await readBody(req, 1024 * 1024))
    else if (url.pathname === `${base}/enable` && req.method === 'POST') {
      const body = await readBody(req, 65536)
      if (
        body.all !== true &&
        (!Array.isArray(body.ids) ||
          !body.ids.length ||
          body.ids.length > 2000 ||
          body.ids.some((id) => typeof id !== 'string'))
      )
        throw new Error('请选择账号')
      data = monitor.setEnabled(body.ids || [], body.enabled, body.all === true)
    } else {
      const match = url.pathname.match(/^\/api\/panel\/vm-quality\/([a-zA-Z0-9_-]+)\/(run|history)$/)
      if (match?.[2] === 'run' && req.method === 'POST') {
        data = monitor.enqueue(match[1])
        status = 202
      } else if (match?.[2] === 'history' && req.method === 'GET') data = monitor.history(match[1])
      else throw Object.assign(new Error('接口不存在'), { status: 404 })
    }
    json(res, status, { ok: true, data })
  } catch (error) {
    json(res, error.status || 400, { ok: false, error: { message: error.message } })
  }
  return true
}
