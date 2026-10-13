import { gzipSync, gunzipSync } from 'node:zlib'

/** Keep small/legacy rows as JSON text; large new rows use a gzip BLOB. */
export function encodeDebugJson(json) {
  if (json.length < 16384) return json
  const raw = Buffer.from(json)
  const packed = gzipSync(raw, { level: 1 })
  return packed.length < raw.length * 0.9 ? packed : json
}

export function decodeDebugJson(value) {
  if (value instanceof Uint8Array) value = gunzipSync(value, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')
  return JSON.parse(value)
}
