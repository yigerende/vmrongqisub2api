import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { DOCS_URL, REPO_URL } from '@/config/repo'
import { ArrowRight } from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { Logo } from '@/assets/logo'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ThemeSwitch } from '@/components/theme-switch'
import { scrollToSection } from './scroll'

const NAV_LINK =
  'rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

export function WelcomeTopBar({
  signedIn,
  username,
}: {
  signedIn: boolean
  username: string
}) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const sections = [
    ...(signedIn ? [{ id: 'welcome-setup', label: '首配清单' }] : []),
    { id: 'welcome-features', label: '能力' },
    { id: 'welcome-quick-start', label: '快速开始' },
    { id: 'welcome-clients', label: '客户端接入' },
  ]

  return (
    <header className='pointer-events-none fixed inset-x-0 top-0 z-50'>
      <div
        className={cn(
          'pointer-events-auto mx-auto transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          scrolled ? 'max-w-[54rem] px-3 pt-3' : 'max-w-7xl px-4 md:px-6'
        )}
      >
        <nav
          aria-label='欢迎页导航'
          className={cn(
            'flex items-center justify-between transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            scrolled
              ? 'h-12 rounded-2xl bg-background/60 pr-1.5 pl-4 shadow-[0_2px_16px_-6px_rgba(0,0,0,0.08)] ring-[0.5px] ring-border/50 backdrop-blur-2xl dark:shadow-[0_2px_16px_-6px_rgba(0,0,0,0.4)]'
              : 'h-16 px-2'
          )}
        >
          <button
            type='button'
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className='group flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <span className='grid size-7 place-items-center rounded-lg bg-foreground text-background transition-transform duration-300 group-hover:scale-105'>
              <Logo aria-hidden className='size-4' />
            </span>
            <span className='text-sm font-semibold tracking-tight'>vm2api</span>
          </button>

          <div className='flex items-center gap-0.5'>
            <div className='hidden items-center gap-0.5 md:flex'>
              {sections.map((s) => (
                <button
                  key={s.id}
                  type='button'
                  className={NAV_LINK}
                  onClick={() => scrollToSection(s.id)}
                >
                  {s.label}
                </button>
              ))}
              <a
                href={DOCS_URL}
                target='_blank'
                rel='noreferrer'
                className={NAV_LINK}
              >
                文档
              </a>
              <div className='mx-2 h-4 w-px bg-border' />
            </div>
            <a
              href={REPO_URL}
              target='_blank'
              rel='noreferrer'
              aria-label='GitHub'
              className='inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            >
              <IconGithub aria-hidden className='size-4' />
            </a>
            <ThemeSwitch />
            <div className='mx-1 h-4 w-px bg-border' />
            {signedIn ? (
              <div className='flex items-center gap-2'>
                <span className='hidden max-w-28 truncate text-xs text-muted-foreground sm:inline'>
                  {username}
                </span>
                <Button
                  asChild
                  size='sm'
                  className='group h-8 rounded-lg px-3.5 text-xs font-medium'
                >
                  <Link to='/overview'>
                    进入控制台
                    <ArrowRight
                      aria-hidden
                      className='size-3.5 transition-transform duration-200 group-hover:translate-x-0.5'
                    />
                  </Link>
                </Button>
              </div>
            ) : (
              <Button
                asChild
                size='sm'
                className='h-8 rounded-lg px-3.5 text-xs font-medium'
              >
                <Link to='/login'>登录</Link>
              </Button>
            )}
          </div>
        </nav>
      </div>
    </header>
  )
}
