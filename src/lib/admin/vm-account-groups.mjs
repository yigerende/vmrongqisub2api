/** Pinned onboarding groups. Live scheduling membership remains in vm_pool_members. */
export function normalizeVmGroupIds(value, legacyPoolId = null) {
  const ids = value == null ? (legacyPoolId ? [legacyPoolId] : []) : value
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string' || !/^pool_[a-f0-9]{8}$/.test(id.trim()))
  ) {
    throw Object.assign(new Error('group_ids 必须为有效的账号分组 ID 数组（最多 100 个）'), {
      code: 'invalid_group_ids',
      status: 400,
    })
  }
  const result = [...new Set(ids.map((id) => id.trim()))].sort()
  if (legacyPoolId && !result.includes(legacyPoolId)) {
    throw Object.assign(new Error('group_ids 与原 pool_id 不一致'), { code: 'invalid_group_ids', status: 400 })
  }
  return result
}
