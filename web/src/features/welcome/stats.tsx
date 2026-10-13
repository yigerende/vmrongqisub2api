import { Reveal } from './reveal'

// Product facts, not traffic metrics: the page never shows numbers it cannot back.
const FACTS = [
  { value: '3', label: '种标准协议入口' },
  { value: '1 : 1', label: '槽位与出口代理一一绑定' },
  { value: '5h · 7d', label: '对齐官方额度窗口调度' },
  { value: '2', label: '平台：Claude 与 GPT 订阅' },
] as const

export function WelcomeStats() {
  return (
    <section className='relative z-10 border-y border-border/40 bg-muted/20 px-6 py-14 md:py-16'>
      <div className='mx-auto grid max-w-6xl grid-cols-2 gap-y-10 md:grid-cols-4'>
        {FACTS.map((f, i) => (
          <Reveal
            key={f.value}
            delay={i * 80}
            className='flex flex-col items-center px-2 text-center'
          >
            <span className='text-3xl font-bold tracking-tight tabular-nums md:text-4xl'>
              {f.value}
            </span>
            <span className='mt-2 max-w-[14rem] text-xs leading-relaxed text-muted-foreground md:text-sm'>
              {f.label}
            </span>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
