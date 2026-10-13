import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { History, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { meQueryOptions } from '@/features/auth/queries'
import type { QualityResult, QualitySnapshot } from './quality-types'

const tone = {
  normal: 'bg-emerald-500',
  error: 'bg-yellow-400',
  degraded: 'bg-red-500',
}
const label = { normal: '没有降智', error: '请求失败', degraded: '降智' }

function qualityResultTitle(row: QualityResult) {
  return `${new Date(row.checked_at).toLocaleString()} · ${row.source === 'manual' ? '手动' : '自动'} · ${label[row.status]}\n${row.question_name} · ${row.reason}`
}

export function VmQualityStatus({ vm }: { vm: Vm }) {
  const me = useQuery(meQueryOptions())
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const snapshot = vm.quality
  const enabled = snapshot?.enabled === true
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
  const toggle = useMutation({
    mutationFn: (value: boolean) =>
      api('/api/panel/vm-quality/enable', {
        method: 'POST',
        body: JSON.stringify({ ids: [vm.id], enabled: value }),
      }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  })
  const run = useMutation({
    mutationFn: () =>
      api(`/api/panel/vm-quality/${encodeURIComponent(vm.id)}/run`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('已加入降智检测队列')
      void refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const history = useQuery({
    queryKey: ['panel', 'quality-history', vm.id],
    queryFn: () =>
      api<QualitySnapshot>(
        `/api/panel/vm-quality/${encodeURIComponent(vm.id)}/history`
      ),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  })
  if (me.data?.role !== 'admin') return null
  const rows = snapshot?.history || []
  const running = snapshot?.running || run.isPending
  return (
    <div className='space-y-1 pt-1' onClick={(e) => e.stopPropagation()}>
      <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
        <Switch
          className='-mx-1 scale-75'
          checked={enabled}
          disabled={toggle.isPending}
          aria-label={`${vm.id} 自动降智检测`}
          onCheckedChange={(value) => toggle.mutate(value)}
        />
        <span>降智检测</span>
        <Button
          size='icon'
          variant='ghost'
          className='size-5'
          aria-label={`${vm.id} 手动降智检测`}
          title='按已保存配置检测一次'
          disabled={running}
          onClick={() => run.mutate()}
        >
          {running ? (
            <Loader2 className='size-3 animate-spin' />
          ) : (
            <Play className='size-3' />
          )}
        </Button>
        <Button
          size='icon'
          variant='ghost'
          className='size-5'
          aria-label={`${vm.id} 降智检测记录`}
          title='检测记录'
          onClick={() => setOpen(true)}
        >
          <History className='size-3' />
        </Button>
      </div>
      {snapshot?.paused_by_quality && (
        <p className='text-[10px] text-amber-600 dark:text-amber-400'>
          降智暂停 · 连续恢复 {snapshot.recovery_streak} 次
        </p>
      )}
      {snapshot?.groups_switched_by_quality && (
        <p className='text-[10px] text-amber-600 dark:text-amber-400'>
          降智已切组 · 连续恢复 {snapshot.recovery_streak} 次
        </p>
      )}
      {snapshot?.group_action_error && (
        <p
          className='max-w-60 text-[10px] text-destructive'
          title={snapshot.group_action_error}
        >
          切组/还原失败：{snapshot.group_action_error}
        </p>
      )}
      {enabled || rows.length > 0 || running ? (
        <div
          className='flex items-center gap-1'
          aria-label={`${vm.id} 降智检测历史`}
        >
          <div className='flex items-center' role='list'>
            {Array.from({ length: Math.max(0, 16 - rows.length) }, (_, i) => (
              <span
                key={`empty-${i}`}
                className='mr-1 size-1.5 rounded-full bg-muted'
                aria-hidden
              />
            ))}
            {rows.map((row) => (
              <Tooltip key={row.id}>
                <TooltipTrigger asChild>
                  <button
                    type='button'
                    role='listitem'
                    className={cn(
                      'mr-1 size-1.5 rounded-full ring-offset-background focus-visible:ring-2 focus-visible:ring-ring',
                      tone[row.status]
                    )}
                    aria-label={qualityResultTitle(row)}
                    onClick={() => setOpen(true)}
                  />
                </TooltipTrigger>
                <TooltipContent className='max-w-80 whitespace-pre-line'>
                  {qualityResultTitle(row)}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          {!rows.length && (
            <span className='text-[10px] text-muted-foreground'>
              {running ? '检测中' : '待检测'}
            </span>
          )}
        </div>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              降智检测记录 · {vm.email || vm.name || vm.id}
            </DialogTitle>
            <DialogDescription>
              绿：没有降智 · 黄：请求失败 ·
              红：降智。手动和自动检测均记录，最新记录在上方。
            </DialogDescription>
          </DialogHeader>
          {history.isLoading ? (
            <p>正在读取…</p>
          ) : history.error ? (
            <p className='text-destructive'>{history.error.message}</p>
          ) : !history.data?.history.length ? (
            <p className='text-sm text-muted-foreground'>暂无检测记录</p>
          ) : (
            [...history.data.history].reverse().map((row) => (
              <div
                key={row.id}
                className='space-y-1 rounded-md border p-3 text-xs'
              >
                <div className='flex flex-wrap items-center gap-2'>
                  <span
                    className={cn('size-2 rounded-full', tone[row.status])}
                  />
                  <strong>{label[row.status]}</strong>
                  <span>{row.source === 'manual' ? '手动' : '自动'}</span>
                  <span className='text-muted-foreground'>
                    {new Date(row.checked_at).toLocaleString()}
                  </span>
                </div>
                <p>
                  {row.question_name} · {row.model} · {row.duration_ms}ms
                </p>
                <p>{row.reason}</p>
                <p>预期答案：{row.expected_answer || '—'}</p>
                {row.answer && (
                  <pre className='max-h-32 overflow-auto rounded bg-muted p-2 break-all whitespace-pre-wrap'>
                    {row.answer}
                  </pre>
                )}
              </div>
            ))
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
