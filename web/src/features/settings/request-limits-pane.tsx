import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'

type Limit = { enabled: boolean; rpm: number; burst: number }
type Scope = 'api' | 'panel'
type EffectiveLimit = Limit & { source: 'web' | 'environment' | 'default' }
type Limits = Record<Scope, EffectiveLimit>
const queryKey = ['panel', 'request-limits'] as const
const sources = { web: '页面配置', environment: '环境变量', default: '默认值' }

function LimitCard({ scope, value }: { scope: Scope; value: EffectiveLimit }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Limit | null>(null)
  const config = draft ?? value
  const title = scope === 'api' ? 'API 调用' : '管理面板'
  const save = useMutation({
    mutationFn: (next: Limit | null) =>
      api<Limits>('/api/panel/request-limits', {
        method: 'PUT',
        body: JSON.stringify({ [scope]: next }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      setDraft(null)
      toast.success(`${title}限流已保存，立即生效`)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const patch = (next: Partial<Limit>) =>
    setDraft({
      enabled: config.enabled,
      rpm: config.rpm,
      burst: config.burst,
      ...next,
    })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    save.mutate({
      enabled: config.enabled,
      rpm: config.rpm,
      burst: config.burst,
    })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className='text-sm text-muted-foreground'>
          {scope === 'api'
            ? '每把 API Key 独立计数，同一把 Key 的所有客户端共享额度。'
            : '管理接口独立计数，登录用户按用户名、管理员 Key 按 Key 计数。Space 的管理调用也使用这一项。'}
        </p>
        <p className='text-sm' role='status'>
          当前生效：
          {value.enabled
            ? `${value.rpm} 次/分钟，突发 ${value.burst} 次`
            : '不限制'}
          <span className='ml-3 text-muted-foreground'>
            来源：{sources[value.source]}
          </span>
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} aria-label={`${title}限流配置`}>
          <fieldset disabled={save.isPending} className='space-y-4'>
            <SettingRow
              label='启用入口限流'
              desc='默认关闭，关闭后此入口不限制请求速率。'
            >
              <Switch
                aria-label={`${title}启用入口限流`}
                checked={config.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </SettingRow>
            <SettingRow
              label='持续请求速率'
              desc='次/分钟。按此速率持续补充可用额度。'
            >
              <Input
                className='w-36 tabular-nums'
                type='number'
                required
                min={0.001}
                max={1000000}
                step='any'
                aria-label={`${title}持续请求速率`}
                disabled={!config.enabled}
                value={config.rpm}
                onChange={(event) => patch({ rpm: Number(event.target.value) })}
              />
            </SettingRow>
            <SettingRow
              label='突发容量'
              desc='额度充足时，允许短时间集中通过的请求次数。'
            >
              <Input
                className='w-36 tabular-nums'
                type='number'
                required
                min={1}
                max={1000000}
                step={1}
                aria-label={`${title}突发容量`}
                disabled={!config.enabled}
                value={config.burst}
                onChange={(event) =>
                  patch({ burst: Number(event.target.value) })
                }
              />
            </SettingRow>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='submit'
                loading={save.isPending}
                disabled={draft === null}
              >
                保存{title}配置
              </Button>
              <Button
                type='button'
                variant='outline'
                disabled={draft === null}
                onClick={() => setDraft(null)}
              >
                放弃修改
              </Button>
              {value.source === 'web' ? (
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => save.mutate(null)}
                >
                  恢复环境默认值
                </Button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  )
}

export function RequestLimitsPane() {
  const query = useQuery({
    queryKey,
    queryFn: () => api<Limits>('/api/panel/request-limits'),
  })
  return (
    <div className='space-y-4'>
      <p className='text-sm text-muted-foreground'>
        API 和管理面板默认均不限制。保存后立即生效，重启后保留。密钥和槽位自身的
        RPM、并发及配额限制仍独立生效。
      </p>
      <QueryGate loading={query.isLoading} error={query.error}>
        {query.data ? (
          <>
            <LimitCard scope='api' value={query.data.api} />
            <LimitCard scope='panel' value={query.data.panel} />
          </>
        ) : null}
      </QueryGate>
    </div>
  )
}
