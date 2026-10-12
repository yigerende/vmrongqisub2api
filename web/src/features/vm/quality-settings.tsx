import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { QualityConfig, QualityQuestion } from './quality-types'

const selectClass = 'h-9 w-full rounded-md border bg-background px-2 text-sm'
const numberFields = [
  ['interval_seconds', '检测间隔（秒）', 10, 86400],
  ['retry_seconds', '异常后重试（秒）', 10, 86400],
  ['timeout_seconds', '请求超时（秒）', 5, 300],
  ['concurrency', '检测并发', 1, 32],
  ['history_limit', '每账号保留记录', 1, 1000],
] as const

export function VmQualitySettings() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['panel', 'quality-settings'],
    queryFn: () => api<QualityConfig>('/api/panel/vm-quality/settings'),
    enabled: open,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const all = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ count: number }>('/api/panel/vm-quality/enable', {
        method: 'POST',
        body: JSON.stringify({ all: true, enabled }),
      }),
    onSuccess: (data, enabled) => {
      toast.success(
        `已${enabled ? '开启' : '关闭'}全部 ${data.count} 个账号的自动降智检测`
      )
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'quality-settings'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
          <BrainCircuit className='size-4' />
          降智检测配置
        </Button>
        <Button
          variant='outline'
          size='sm'
          disabled={all.isPending}
          onClick={() => all.mutate(true)}
          title='开启所有账号，并默认开启后续新增账号'
        >
          全部开启检测
        </Button>
        <Button
          variant='ghost'
          size='sm'
          disabled={all.isPending}
          onClick={() => all.mutate(false)}
          title='关闭所有账号，并默认关闭后续新增账号'
        >
          全部关闭
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>降智检测配置</DialogTitle>
            <DialogDescription>
              按题库顺序，每次检测一道题。自动和手动测试共用已保存配置，检测会消耗账号额度。绿色正常、黄色请求失败、红色降智。
            </DialogDescription>
          </DialogHeader>
          {query.isLoading ? (
            <p>读取配置中…</p>
          ) : query.error ? (
            <p className='text-destructive'>{query.error.message}</p>
          ) : query.data ? (
            <QualityForm
              key={query.dataUpdatedAt}
              initial={query.data}
              onSaved={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function QualityForm({
  initial,
  onSaved,
}: {
  initial: QualityConfig
  onSaved: () => void
}) {
  const [value, setValue] = useState(initial)
  const qc = useQueryClient()
  const set = <K extends keyof QualityConfig>(key: K, next: QualityConfig[K]) =>
    setValue((old) => ({ ...old, [key]: next }))
  const question = (id: string, patch: Partial<QualityQuestion>) =>
    setValue((old) => ({
      ...old,
      questions: old.questions.map((q) =>
        q.id === id ? { ...q, ...patch } : q
      ),
    }))
  const save = useMutation({
    mutationFn: () =>
      api<QualityConfig>('/api/panel/vm-quality/settings', {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['panel', 'quality-settings'], data)
      toast.success('降智检测配置已保存')
      onSaved()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <form
      className='space-y-5'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <label className='space-y-1 text-xs'>
          GPT 检测模型
          <Input
            value={value.model}
            required
            maxLength={200}
            onChange={(e) => set('model', e.target.value)}
          />
        </label>
        <label className='space-y-1 text-xs'>
          Claude 检测模型
          <Input
            value={value.claude_model}
            required
            maxLength={200}
            onChange={(e) => set('claude_model', e.target.value)}
          />
        </label>
        <label className='space-y-1 text-xs'>
          GPT 推理强度
          <select
            className={selectClass}
            value={value.reasoning_effort}
            onChange={(e) =>
              set(
                'reasoning_effort',
                e.target.value as QualityConfig['reasoning_effort']
              )
            }
          >
            {['low', 'medium', 'high', 'xhigh'].map((effort) => (
              <option key={effort}>{effort}</option>
            ))}
          </select>
        </label>
        <label className='space-y-1 text-xs'>
          判断方式
          <select
            className={selectClass}
            value={value.mode}
            onChange={(e) =>
              set('mode', e.target.value as QualityConfig['mode'])
            }
          >
            <option value='content_time'>答案 + 耗时（均达标）</option>
            <option value='content'>仅答案</option>
            <option value='time'>仅耗时</option>
          </select>
        </label>
        {numberFields.map(([key, label, min, max]) => (
          <label key={key} className='space-y-1 text-xs'>
            {label}
            <Input
              type='number'
              required
              min={min}
              max={max}
              step={1}
              value={value[key]}
              onChange={(e) => set(key, Number(e.target.value))}
            />
          </label>
        ))}
        <label className='flex items-center gap-2 text-xs'>
          <Switch
            checked={value.default_enabled}
            onCheckedChange={(next) => set('default_enabled', next)}
          />
          新增账号默认开启检测
        </label>
      </div>
      <div className='space-y-3 rounded-lg border p-3'>
        <label className='flex items-center gap-2 text-sm font-medium'>
          <Switch
            checked={value.pause_on_degraded}
            aria-label='降智后暂停调度'
            onCheckedChange={(next) => set('pause_on_degraded', next)}
          />
          降智后暂停调度
        </label>
        <div className='grid gap-3 sm:grid-cols-2'>
          {(
            [
              ['failure_limit', '连续降智次数'],
              ['recovery_limit', '连续恢复次数'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className='space-y-1 text-xs'>
              {label}
              <Input
                type='number'
                value={value[key]}
                min={1}
                max={1000}
                step={1}
                required
                disabled={!value.pause_on_degraded}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
        <p className='text-xs text-muted-foreground'>
          连续红色达到次数后暂停调度，连续绿色达到次数后恢复。黄色请求失败不计数，也不中断连续次数；手动检测同样计数。
          仅恢复由降智检测暂停的账号，手动暂停不会自动开启。暂停期间自动检测继续运行。
        </p>
        <p className='text-xs text-muted-foreground'>
          修改检测配置或手动切换调度后重新计数。关闭此选项不会自动开启已暂停账号，可手动开启调度。
        </p>
      </div>
      <div className='space-y-3'>
        <div className='flex items-center justify-between'>
          <h3 className='text-sm font-medium'>检测题库</h3>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={value.questions.length >= 50}
            onClick={() =>
              set('questions', [
                ...value.questions,
                {
                  id: crypto.randomUUID(),
                  name: `题目 ${value.questions.length + 1}`,
                  enabled: true,
                  prompt: '',
                  answer: '',
                  match_mode: 'answer',
                  max_duration_ms: 20000,
                },
              ])
            }
          >
            <Plus className='size-3' />
            添加题目
          </Button>
        </div>
        {value.questions.map((q, index) => (
          <div key={q.id} className='space-y-2 rounded-lg border p-3'>
            <div className='flex items-center gap-2'>
              <Switch
                checked={q.enabled}
                aria-label={`启用题目 ${index + 1}`}
                onCheckedChange={(enabled) => question(q.id, { enabled })}
              />
              <Input
                className='flex-1'
                aria-label={`题目 ${index + 1} 名称`}
                value={q.name}
                maxLength={200}
                required
                onChange={(e) => question(q.id, { name: e.target.value })}
              />
              <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label={`删除题目 ${index + 1}`}
                disabled={value.questions.length === 1}
                onClick={() =>
                  set(
                    'questions',
                    value.questions.filter((item) => item.id !== q.id)
                  )
                }
              >
                <Trash2 className='size-4' />
              </Button>
            </div>
            <Textarea
              aria-label={`题目 ${index + 1} 内容`}
              rows={3}
              value={q.prompt}
              required
              maxLength={15000}
              placeholder='检测提示词'
              onChange={(e) => question(q.id, { prompt: e.target.value })}
            />
            <div className='grid gap-2 sm:grid-cols-3'>
              <label className='space-y-1 text-xs'>
                预期答案
                <Input
                  value={q.answer}
                  required={value.mode !== 'time'}
                  maxLength={2000}
                  onChange={(e) => question(q.id, { answer: e.target.value })}
                />
              </label>
              <label className='space-y-1 text-xs'>
                匹配方式
                <select
                  className={selectClass}
                  value={q.match_mode}
                  onChange={(e) =>
                    question(q.id, {
                      match_mode: e.target
                        .value as QualityQuestion['match_mode'],
                    })
                  }
                >
                  <option value='answer'>标准答案</option>
                  <option value='keyword'>包含关键词</option>
                  <option value='regex'>正则表达式</option>
                </select>
              </label>
              <label className='space-y-1 text-xs'>
                耗时小于（毫秒）
                <Input
                  type='number'
                  value={q.max_duration_ms}
                  min={1}
                  max={300000}
                  step={1}
                  required
                  onChange={(e) =>
                    question(q.id, { max_duration_ms: Number(e.target.value) })
                  }
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <p className='text-xs text-muted-foreground'>
        标准答案支持纯答案或单行
        FINAL_ANSWER=答案。开启“降智后暂停调度”才会按连续次数调整调度开关。
      </p>
      <DialogFooter>
        <Button type='submit' disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存配置'}
        </Button>
      </DialogFooter>
    </form>
  )
}
