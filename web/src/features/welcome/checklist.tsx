import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  Circle,
  Globe,
  KeyRound,
  ListChecks,
  LockKeyhole,
  Power,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useOnboardingAction } from './queries'
import {
  docsHref,
  hasPanelView,
  isOnboardingStepId,
  STEP_META,
  type OnboardingStepId,
} from './steps'
import type { OnboardingPayload } from './types'

const STEP_ICONS: Record<OnboardingStepId, LucideIcon> = {
  admin_password: LockKeyhole,
  egress: Globe,
  slot_account: Boxes,
  schedulable: Power,
  api_key: KeyRound,
  first_request: Send,
}

export function WelcomeChecklist({
  payload,
  views,
}: {
  payload: OnboardingPayload
  views?: string[] | null
}) {
  const action = useOnboardingAction()
  const known = payload.steps.filter(
    (step): step is { id: OnboardingStepId; done: boolean } =>
      isOnboardingStepId(step.id)
  )
  const doneCount = known.filter((step) => step.done).length
  const total = known.length
  const allDone = total > 0 && doneCount >= total
  const percent = total === 0 ? 100 : Math.round((doneCount / total) * 100)
  const next = known.find((step) => !step.done)

  function run(kind: 'complete' | 'dismiss' | 'reset') {
    action.mutate(kind, {
      onSuccess: () => {
        toast.success(
          kind === 'reset'
            ? '将再次显示引导'
            : kind === 'complete'
              ? '已完成引导'
              : '已跳过引导'
        )
      },
      onError: (error: Error) => toast.error(error.message),
    })
  }

  return (
    <section
      id='welcome-setup'
      className='relative z-10 scroll-mt-20 px-6 pb-8'
    >
      <div className='welcome-fade-up mx-auto max-w-6xl overflow-hidden rounded-2xl border bg-card shadow-xs'>
        <div className='relative p-4 sm:p-6'>
          <div
            aria-hidden
            className='pointer-events-none absolute inset-0 opacity-60 dark:opacity-30'
            style={{
              background:
                'radial-gradient(ellipse 50% 60% at 0% 0%, oklch(0.72 0.18 250 / 14%) 0%, transparent 70%), radial-gradient(ellipse 40% 50% at 100% 0%, oklch(0.70 0.12 280 / 12%) 0%, transparent 70%)',
            }}
          />
          <div className='relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]'>
            <div className='flex min-w-0 flex-col gap-5'>
              <div className='flex max-w-2xl flex-col gap-1'>
                <div className='flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase'>
                  <ListChecks aria-hidden className='size-3.5' />
                  首配清单
                </div>
                <h2 className='text-xl font-semibold tracking-tight sm:text-2xl'>
                  几分钟把这台网关配到能用
                </h2>
                <p className='text-sm leading-relaxed text-muted-foreground'>
                  状态读自网关当前的真实数据，做完一步刷新就会打勾。
                </p>
              </div>

              <ol className='rounded-2xl border bg-background/45 p-2 backdrop-blur'>
                {known.map((step, i) => {
                  const meta = STEP_META[step.id]
                  const Icon = STEP_ICONS[step.id]
                  const StatusIcon = step.done ? Check : Circle
                  const showPanel = hasPanelView(views, meta.panelView)
                  return (
                    <li
                      key={step.id}
                      className='relative flex gap-3 pb-2.5 last:pb-0'
                    >
                      {i < known.length - 1 ? (
                        <span
                          aria-hidden
                          className='absolute top-9 bottom-0 left-4 w-px bg-border'
                        />
                      ) : null}
                      <span
                        className={cn(
                          'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs',
                          step.done &&
                            'border-[color-mix(in_oklch,var(--welcome-success)_30%,transparent)] bg-[color-mix(in_oklch,var(--welcome-success)_10%,var(--background))]'
                        )}
                      >
                        <StatusIcon
                          aria-hidden
                          className={cn(
                            'size-4',
                            step.done
                              ? 'text-[var(--welcome-success)]'
                              : 'text-muted-foreground/60'
                          )}
                        />
                        <span className='sr-only'>
                          {step.done ? '已完成' : '未完成'}
                        </span>
                      </span>
                      <div className='flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/70 px-3 py-2.5 shadow-xs'>
                        <div className='flex min-w-0 items-start gap-2.5'>
                          <span className='mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted'>
                            <Icon aria-hidden className='size-3.5' />
                          </span>
                          <span className='flex min-w-0 flex-col gap-0.5'>
                            <span className='flex items-center gap-2 text-sm font-medium'>
                              <span className='font-mono text-xs text-muted-foreground tabular-nums'>
                                {i + 1}.
                              </span>
                              <span
                                className={cn(
                                  'truncate',
                                  step.done &&
                                    'text-muted-foreground line-through decoration-muted-foreground/40'
                                )}
                              >
                                {meta.title}
                              </span>
                            </span>
                            <span className='text-xs leading-relaxed text-muted-foreground'>
                              {meta.description}
                            </span>
                          </span>
                        </div>
                        <div className='ms-auto flex shrink-0 items-center gap-1'>
                          <a
                            href={docsHref(meta.docsPath)}
                            target='_blank'
                            rel='noreferrer'
                            className='inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                          >
                            文档
                            <ArrowUpRight aria-hidden className='size-3' />
                          </a>
                          {showPanel ? (
                            <Button
                              asChild
                              size='sm'
                              variant={step.done ? 'ghost' : 'outline'}
                              className='group h-8 rounded-lg px-2.5 text-xs'
                            >
                              <Link to={meta.panelTo}>
                                前往
                                <ArrowRight
                                  aria-hidden
                                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                                />
                              </Link>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>

            <aside className='flex flex-col gap-4 rounded-2xl border bg-background/60 p-4 backdrop-blur sm:p-5'>
              <div className='flex items-baseline justify-between'>
                <span className='text-xs font-medium tracking-wider text-muted-foreground uppercase'>
                  进度
                </span>
                <span className='font-mono text-sm tabular-nums'>
                  {doneCount}/{total}
                </span>
              </div>
              <div
                role='progressbar'
                aria-label='引导进度'
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className='h-2 overflow-hidden rounded-full bg-muted'
              >
                <div
                  className='h-full rounded-full bg-gradient-to-r from-blue-400 via-violet-400 to-purple-500 transition-[width] duration-500'
                  style={{ width: `${percent}%` }}
                />
              </div>

              {next ? (
                <div className='rounded-xl border bg-card px-3 py-3'>
                  <p className='text-xs text-muted-foreground'>下一步</p>
                  <p className='mt-0.5 text-sm font-medium'>
                    {STEP_META[next.id].title}
                  </p>
                  {hasPanelView(views, STEP_META[next.id].panelView) ? (
                    <Button
                      asChild
                      size='sm'
                      className='group mt-3 h-8 w-full rounded-lg text-xs'
                    >
                      <Link to={STEP_META[next.id].panelTo}>
                        去完成
                        <ArrowRight
                          aria-hidden
                          className='size-3.5 transition-transform group-hover:translate-x-0.5'
                        />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className='flex items-center gap-2 rounded-xl border bg-card px-3 py-3 text-sm'>
                  <Check
                    aria-hidden
                    className='size-4 text-[var(--welcome-success)]'
                  />
                  所有步骤都已就绪
                </div>
              )}

              <div className='mt-auto flex flex-col gap-2 border-t pt-4'>
                {payload.status !== 'pending' ? (
                  <>
                    <p className='text-xs leading-relaxed text-muted-foreground'>
                      {payload.status === 'completed'
                        ? '已完成引导'
                        : '已跳过引导'}
                      ，登录后直接进控制台。
                    </p>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-lg text-xs'
                      disabled={action.isPending}
                      onClick={() => run('reset')}
                    >
                      重新显示引导
                    </Button>
                  </>
                ) : allDone ? (
                  <Button
                    size='sm'
                    className='h-8 rounded-lg text-xs'
                    disabled={action.isPending}
                    onClick={() => run('complete')}
                  >
                    完成引导
                  </Button>
                ) : (
                  <>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-lg text-xs'
                      disabled={action.isPending}
                      onClick={() => run('dismiss')}
                    >
                      跳过引导
                    </Button>
                    <p className='text-[11px] leading-relaxed text-muted-foreground'>
                      跳过后登录直接进控制台，用户菜单「欢迎与引导」可再打开。
                    </p>
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}
