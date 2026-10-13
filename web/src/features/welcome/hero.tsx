import { Link } from '@tanstack/react-router'
import CherryStudioColor from '@lobehub/icons/es/CherryStudio/components/Color'
import ClaudeCodeColor from '@lobehub/icons/es/ClaudeCode/components/Color'
import CodexColor from '@lobehub/icons/es/Codex/components/Color'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import { ArrowRight, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiDemo } from './api-demo'
import { scrollToSection } from './scroll'
import { docsHref } from './steps'

const CLIENTS = [
  { name: 'Claude Code', Icon: ClaudeCodeColor },
  { name: 'Codex CLI', Icon: CodexColor },
  { name: 'Cherry Studio', Icon: CherryStudioColor },
  { name: 'OpenAI SDK', Icon: OpenAI },
] as const

export function WelcomeHero({
  signedIn,
  baseUrl,
}: {
  signedIn: boolean
  baseUrl: string
}) {
  return (
    <section className='relative z-10 overflow-hidden px-6 pt-28 pb-16 md:pt-36 md:pb-24 lg:pb-28'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 opacity-25 dark:opacity-[0.12]'
        style={{
          background: [
            'radial-gradient(ellipse 60% 50% at 20% 20%, oklch(0.72 0.18 250 / 80%) 0%, transparent 70%)',
            'radial-gradient(ellipse 50% 40% at 80% 15%, oklch(0.65 0.15 200 / 60%) 0%, transparent 70%)',
            'radial-gradient(ellipse 40% 35% at 40% 80%, oklch(0.70 0.12 280 / 40%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_30%,black_20%,transparent_100%)] bg-[size:4rem_4rem] opacity-[0.35]'
      />

      <div className='mx-auto grid max-w-6xl grid-cols-1 items-start gap-12 lg:grid-cols-12 lg:gap-8'>
        <div className='flex flex-col items-start lg:col-span-6'>
          <div className='welcome-fade-up mb-5 inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-[11px] font-medium text-blue-600 shadow-xs dark:border-blue-400/20 dark:bg-blue-400/5 dark:text-blue-400'>
            <span className='relative flex size-1.5'>
              <span className='absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75 motion-reduce:animate-none' />
              <span className='relative inline-flex size-1.5 rounded-full bg-blue-500 dark:bg-blue-400' />
            </span>
            虚拟化号池网关 · 自建部署
          </div>

          <h1
            className='welcome-fade-up text-[clamp(2.25rem,4.5vw,3.25rem)] leading-[1.15] font-bold tracking-tight'
            style={{ animationDelay: '60ms' }}
          >
            把订阅号池
            <br />
            <span className='bg-gradient-to-r from-blue-400 via-violet-400 to-purple-500 bg-clip-text text-transparent'>
              变成标准 API
            </span>
          </h1>
          <p
            className='welcome-fade-up mt-5 max-w-xl text-base leading-relaxed text-muted-foreground md:text-[15px]'
            style={{ animationDelay: '120ms' }}
          >
            每个槽位里跑官方客户端，账号与出口一一隔离。对外提供 Anthropic /
            OpenAI 兼容接口，Claude Code、Codex 和现有 SDK 改个地址就能用。
          </p>

          <div
            className='welcome-fade-up mt-8 flex flex-wrap items-center gap-3'
            style={{ animationDelay: '180ms' }}
          >
            {signedIn ? (
              <Button
                asChild
                className='group h-11 rounded-lg px-5 text-sm font-medium'
              >
                <Link to='/overview'>
                  进入控制台
                  <ArrowRight
                    aria-hidden
                    className='size-4 transition-transform duration-200 group-hover:translate-x-0.5'
                  />
                </Link>
              </Button>
            ) : (
              <Button
                asChild
                className='group h-11 rounded-lg px-5 text-sm font-medium'
              >
                <Link to='/login'>
                  登录控制台
                  <ArrowRight
                    aria-hidden
                    className='size-4 transition-transform duration-200 group-hover:translate-x-0.5'
                  />
                </Link>
              </Button>
            )}
            <Button
              variant='outline'
              className='h-11 rounded-lg border-border/50 px-5 text-sm font-medium hover:border-border hover:bg-muted/50'
              onClick={() =>
                scrollToSection(
                  signedIn ? 'welcome-setup' : 'welcome-quick-start'
                )
              }
            >
              {signedIn ? '首配清单' : '快速开始'}
            </Button>
            <Button
              asChild
              variant='outline'
              className='group h-11 rounded-lg border-border/50 px-5 text-sm font-medium hover:border-border hover:bg-muted/50'
            >
              <a
                href={docsHref('guide/quick-start')}
                target='_blank'
                rel='noreferrer'
              >
                <BookOpen
                  aria-hidden
                  className='size-4 text-muted-foreground/80 transition-colors group-hover:text-foreground'
                />
                文档
              </a>
            </Button>
          </div>

          <div
            className='welcome-fade-up mt-10 w-full max-w-xl'
            style={{ animationDelay: '240ms' }}
          >
            <p className='text-[10px] font-bold tracking-[0.15em] text-muted-foreground/60 uppercase'>
              常用客户端
            </p>
            <p className='mt-1 text-xs leading-relaxed text-muted-foreground/70'>
              改 base URL 与密钥即可接入，不需要插件或补丁。
            </p>
            <ul className='mt-4 flex flex-wrap items-center gap-2.5'>
              {CLIENTS.map(({ name, Icon }) => (
                <li
                  key={name}
                  className='flex items-center gap-2 rounded-full border border-border/40 bg-muted/15 px-3.5 py-2 text-[13px] font-medium text-foreground/80 backdrop-blur-xs'
                >
                  <Icon size={18} className='shrink-0' />
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className='welcome-fade-up flex w-full justify-center lg:col-span-6'
          style={{ animationDelay: '320ms' }}
        >
          <ApiDemo baseUrl={baseUrl} />
        </div>
      </div>
    </section>
  )
}
