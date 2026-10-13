import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Plays a one-shot entrance once the block scrolls into view. */
export function Reveal({
  children,
  className,
  delay = 0,
  animation = 'fade-up',
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  delay?: number
  animation?: 'fade-up' | 'scale-in'
  as?: 'div' | 'li' | 'section'
}) {
  const ref = useRef<HTMLElement | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || shown) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [shown])

  return (
    <Tag
      ref={(node: HTMLElement | null) => {
        ref.current = node
      }}
      className={cn(
        shown
          ? animation === 'scale-in'
            ? 'welcome-scale-in'
            : 'welcome-fade-up'
          : 'welcome-reveal-pending',
        className
      )}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
