import { Link } from '@tanstack/react-router'
import { REPO_URL } from '@/config/repo'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Reveal } from './reveal'
import { docsHref } from './steps'

export function WelcomeCta({ signedIn }: { signedIn: boolean }) {
  return (
    <section className='relative z-10 overflow-hidden px-6 py-24 md:py-32'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 opacity-20 dark:opacity-[0.08]'
        style={{
          background: [
            'radial-gradient(ellipse 50% 50% at 30% 50%, oklch(0.7 0.15 250 / 70%) 0%, transparent 70%)',
            'radial-gradient(ellipse 40% 40% at 70% 40%, oklch(0.65 0.12 200 / 50%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />
      <Reveal animation='scale-in' className='mx-auto max-w-2xl text-center'>
        <h2 className='text-2xl leading-tight font-bold tracking-tight md:text-4xl'>
          {signedIn ? '配置完成后' : '准备好了吗'}
          <br />
          <span className='bg-gradient-to-r from-blue-400 via-violet-400 to-purple-500 bg-clip-text text-transparent'>
            {signedIn ? '去控制台看第一条请求' : '登录开始首配'}
          </span>
        </h2>
        <p className='mx-auto mt-5 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base'>
          控制台里能看到每个槽位的额度、每次调度和每条请求日志。
        </p>
        <div className='mt-8 flex items-center justify-center gap-3'>
          {signedIn ? (
            <Button asChild className='group rounded-lg'>
              <Link to='/overview'>
                进入控制台
                <ArrowRight
                  aria-hidden
                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                />
              </Link>
            </Button>
          ) : (
            <Button asChild className='group rounded-lg'>
              <Link to='/login'>
                登录控制台
                <ArrowRight
                  aria-hidden
                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                />
              </Link>
            </Button>
          )}
          <Button
            asChild
            variant='outline'
            className='rounded-lg border-border/50 hover:border-border hover:bg-muted/50'
          >
            <a
              href={docsHref('guide/install')}
              target='_blank'
              rel='noreferrer'
            >
              安装文档
            </a>
          </Button>
        </div>
      </Reveal>
    </section>
  )
}

export function WelcomeFooter() {
  return (
    <footer className='relative z-10 px-6 pb-10'>
      <div className='mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-6 text-xs text-muted-foreground'>
        <span className='font-medium text-foreground/80'>vm2api</span>
        <span>
          个人学习与非商用自建 ·{' '}
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            className='underline-offset-4 hover:text-foreground hover:underline'
          >
            GitHub
          </a>
        </span>
      </div>
    </footer>
  )
}
