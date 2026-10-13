import { ArrowUpRight, Download, PlugZap, Server } from 'lucide-react'
import { Reveal } from './reveal'
import { docsHref } from './steps'

const STEPS = [
  {
    n: '1',
    Icon: Server,
    title: '安装',
    body: '一键脚本或 Docker Compose 拉起控制面，打开 /console 登录。',
    href: docsHref('guide/install'),
    label: '安装文档',
  },
  {
    n: '2',
    Icon: Download,
    title: '导入',
    body: '建槽、绑出口、写入订阅账号，等官方初装完成后打开调度。',
    href: docsHref('guide/console/import'),
    label: '导入文档',
  },
  {
    n: '3',
    Icon: PlugZap,
    title: '调用',
    body: '签发 sk-vm- 密钥，把客户端的 base URL 指到这台网关。',
    href: docsHref('guide/clients'),
    label: '接入文档',
  },
] as const

export function WelcomeQuickStart() {
  return (
    <section
      id='welcome-quick-start'
      className='relative z-10 scroll-mt-20 border-t border-border/40 px-6 py-24 md:py-32'
    >
      <div className='mx-auto max-w-6xl'>
        <Reveal className='mb-16 text-center md:mb-20'>
          <p className='mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase'>
            快速开始
          </p>
          <h2 className='text-2xl font-bold tracking-tight md:text-3xl'>
            三步用起来
          </h2>
          <p className='mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground'>
            顺序就是生产路径：先有控制面，再有可调度的槽，最后才是客户端。
          </p>
        </Reveal>

        <ol className='grid gap-12 md:grid-cols-3'>
          {STEPS.map(({ n, Icon, title, body, href, label }, i) => (
            <Reveal
              as='li'
              key={n}
              delay={i * 150}
              className='flex flex-col items-center text-center'
            >
              <div className='relative mb-6'>
                <div className='flex size-16 items-center justify-center rounded-2xl border border-border/50 bg-muted/30 text-muted-foreground'>
                  <Icon aria-hidden className='size-6' strokeWidth={1.5} />
                </div>
                <span className='absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background'>
                  {n}
                </span>
              </div>
              <h3 className='mb-2 text-base font-semibold'>{title}</h3>
              <p className='max-w-[240px] text-sm leading-relaxed text-muted-foreground'>
                {body}
              </p>
              <a
                href={href}
                target='_blank'
                rel='noreferrer'
                className='mt-4 inline-flex items-center gap-1 rounded-md text-sm font-medium text-foreground/80 underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
              >
                {label}
                <ArrowUpRight aria-hidden className='size-3.5 opacity-70' />
              </a>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  )
}
