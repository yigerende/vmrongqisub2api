import { useState } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton, CopyChip } from '@/components/copy-chip'
import { Reveal } from './reveal'
import { docsHref } from './steps'

const NOTES = [
  '密钥用控制台签发的 sk-vm-…，明文只显示一次。',
  'Master 的 VM2API_API_KEY 能改面板，不要写进客户端。',
  'Claude Code 的 base URL 填主机；Codex 与 OpenAI SDK 填主机加 /v1。',
] as const

export function WelcomeClientSnippets({ baseUrl }: { baseUrl: string }) {
  const base = baseUrl.replace(/\/$/, '') || location.origin
  const tabs = [
    {
      id: 'claude',
      label: 'Claude Code',
      file: 'shell',
      hint: 'ANTHROPIC_BASE_URL 是主机，不要带 /v1',
      code: [
        `export ANTHROPIC_BASE_URL=${base}`,
        'export ANTHROPIC_AUTH_TOKEN=sk-vm-xxxx',
        'claude',
      ].join('\n'),
    },
    {
      id: 'codex',
      label: 'Codex',
      file: '~/.codex/config.toml',
      hint: 'env_key 指向 VM2API_KEY，不是 Master 的 VM2API_API_KEY',
      code: [
        'model = "gpt-5.4"',
        'model_provider = "vm2api"',
        '',
        '[model_providers.vm2api]',
        'name = "vm2api"',
        `base_url = "${base}/v1"`,
        'env_key = "VM2API_KEY"',
        'wire_api = "responses"',
      ].join('\n'),
    },
    {
      id: 'curl',
      label: 'curl',
      file: 'POST /v1/messages',
      hint: '鉴权通过且有可调度槽位时返回 content',
      code: [
        `curl -sS ${base}/v1/messages \\`,
        '  -H "Authorization: Bearer sk-vm-xxxx" \\',
        '  -H "content-type: application/json" \\',
        "  -d '{",
        '    "model": "claude-sonnet-5",',
        '    "max_tokens": 1024,',
        '    "messages": [{"role": "user", "content": "hello"}]',
        "  }'",
      ].join('\n'),
    },
  ]
  const [active, setActive] = useState(0)
  const tab = tabs[active]

  return (
    <section
      id='welcome-clients'
      className='relative z-10 scroll-mt-20 border-t border-border/40 px-6 py-24 md:py-32'
    >
      <div className='mx-auto grid max-w-6xl items-start gap-12 lg:grid-cols-12 lg:gap-10'>
        <Reveal className='lg:col-span-5'>
          <p className='mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase'>
            客户端接入
          </p>
          <h2 className='text-2xl leading-tight font-bold tracking-tight md:text-3xl'>
            改一个地址，
            <br />
            现有工具直接用
          </h2>
          <p className='mt-4 max-w-md text-sm leading-relaxed text-muted-foreground'>
            这台网关的入口：
          </p>
          <div className='mt-2'>
            <CopyChip text={`${base}/v1`} className='rounded-lg px-3 py-1.5' />
          </div>
          <ul className='mt-6 space-y-3'>
            {NOTES.map((n) => (
              <li
                key={n}
                className='flex gap-2.5 text-sm leading-relaxed text-muted-foreground'
              >
                <span className='mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40'>
                  <Check aria-hidden className='size-3' />
                </span>
                {n}
              </li>
            ))}
          </ul>
          <a
            href={docsHref('guide/clients')}
            target='_blank'
            rel='noreferrer'
            className='mt-6 inline-flex items-center gap-1 rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            完整接入说明
            <ArrowUpRight aria-hidden className='size-3.5 opacity-70' />
          </a>
        </Reveal>

        <Reveal
          animation='scale-in'
          delay={120}
          className='min-w-0 lg:col-span-7'
        >
          <div className='overflow-hidden rounded-2xl border border-border/60 bg-white/95 shadow-[0_20px_50px_-25px_rgba(15,23,42,0.18)] dark:border-white/[0.06] dark:bg-[#0b0f17]/95 dark:shadow-[0_20px_60px_-25px_rgba(0,0,0,0.7)]'>
            <div
              role='tablist'
              aria-label='客户端配置'
              className='flex items-center gap-1 border-b border-border/50 px-2 sm:px-3 dark:border-white/[0.05]'
            >
              {tabs.map((t, i) => (
                <button
                  key={t.id}
                  type='button'
                  role='tab'
                  aria-selected={i === active}
                  onClick={() => setActive(i)}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-2.5 text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    i === active
                      ? 'border-blue-500 text-blue-600 dark:text-blue-300'
                      : 'border-transparent text-foreground/40 hover:text-foreground/70'
                  )}
                >
                  {t.label}
                </button>
              ))}
              <CopyButton
                text={tab.code}
                label={`复制 ${tab.label} 配置`}
                className='ms-auto'
              />
            </div>
            <div className='flex items-center justify-between gap-3 border-b border-border/40 px-5 py-2.5 dark:border-white/[0.04]'>
              <code className='truncate font-mono text-[12px] text-foreground/75'>
                {tab.file}
              </code>
              <span className='hidden truncate text-[11px] text-foreground/40 sm:inline'>
                {tab.hint}
              </span>
            </div>
            <pre className='min-h-[220px] overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-[1.6] text-foreground/80'>
              {tab.code}
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
