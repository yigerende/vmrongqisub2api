import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/copy-chip'

type Demo = {
  id: string
  label: string
  path: string
  auth: string
  body: string[]
  response: string[]
  tone: { text: string; border: string; badge: string }
}

const TONES = {
  violet: {
    text: 'text-violet-600 dark:text-violet-300',
    border: 'border-violet-500',
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  },
  emerald: {
    text: 'text-emerald-600 dark:text-emerald-300',
    border: 'border-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  },
  amber: {
    text: 'text-amber-600 dark:text-amber-300',
    border: 'border-amber-500',
    badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
}

// Example payloads mirror the three entries documented on /guide/api.
const DEMOS: Demo[] = [
  {
    id: 'messages',
    label: 'Claude',
    path: '/v1/messages',
    auth: 'x-api-key: sk-vm-xxxx',
    body: [
      '"model": "claude-sonnet-5",',
      '"max_tokens": 1024,',
      '"messages": [{ "role": "user", "content": "hello" }]',
    ],
    response: [
      '{',
      '  "type": "message",',
      '  "content": [{ "type": "text", "text": "Hello!" }],',
      '  "usage": { "input_tokens": 8, "output_tokens": 5 }',
      '}',
    ],
    tone: TONES.violet,
  },
  {
    id: 'chat',
    label: 'Chat',
    path: '/v1/chat/completions',
    auth: 'Authorization: Bearer sk-vm-xxxx',
    body: [
      '"model": "gpt-5.4",',
      '"messages": [{ "role": "user", "content": "hello" }]',
    ],
    response: [
      '{',
      '  "object": "chat.completion",',
      '  "choices": [{ "message": { "content": "Hello!" } }]',
      '}',
    ],
    tone: TONES.emerald,
  },
  {
    id: 'responses',
    label: 'Responses',
    path: '/v1/responses',
    auth: 'Authorization: Bearer sk-vm-xxxx',
    body: ['"model": "gpt-5.4",', '"input": "hello"'],
    response: [
      '{',
      '  "object": "response",',
      '  "output": [{ "type": "message", "content": [ … ] }]',
      '}',
    ],
    tone: TONES.amber,
  },
]

const STRING_RE = /"[^"]*"/g

/** Colors JSON-ish lines: keys sky, string values amber, punctuation muted. */
function Json({ line }: { line: string }) {
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const m of line.matchAll(STRING_RE)) {
    const start = m.index ?? 0
    if (start > cursor)
      parts.push(
        <span key={`p${start}`} className='text-foreground/55'>
          {line.slice(cursor, start)}
        </span>
      )
    const isKey = line
      .slice(start + m[0].length)
      .trimStart()
      .startsWith(':')
    parts.push(
      <span
        key={`s${start}`}
        className={
          isKey
            ? 'text-sky-700 dark:text-sky-300'
            : 'text-amber-700 dark:text-amber-300'
        }
      >
        {m[0]}
      </span>
    )
    cursor = start + m[0].length
  }
  if (cursor < line.length)
    parts.push(
      <span key='tail' className='text-foreground/55'>
        {line.slice(cursor)}
      </span>
    )
  return <div className='break-words whitespace-pre-wrap'>{parts}</div>
}

/** Static request/response card: switching tabs is the only interaction. */
export function ApiDemo({ baseUrl }: { baseUrl: string }) {
  const [active, setActive] = useState(0)
  const demo = DEMOS[active]
  const curl = [
    `curl -X POST "${baseUrl}${demo.path}" \\`,
    `  -H "${demo.auth}" \\`,
    '  -H "content-type: application/json" \\',
    "  -d '{",
    ...demo.body.map((l) => `    ${l}`),
    "  }'",
  ].join('\n')

  return (
    <div className='mx-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-white/95 shadow-[0_20px_50px_-25px_rgba(15,23,42,0.18)] backdrop-blur-sm dark:border-white/[0.06] dark:bg-[#0b0f17]/95 dark:shadow-[0_20px_60px_-25px_rgba(0,0,0,0.7)]'>
      <div
        role='tablist'
        aria-label='接口示例'
        className='flex items-center gap-1 border-b border-border/50 px-2 sm:px-3 dark:border-white/[0.05]'
      >
        {DEMOS.map((d, i) => (
          <button
            key={d.id}
            type='button'
            role='tab'
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={cn(
              '-mb-px border-b-2 px-2.5 py-2.5 text-[11px] font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-3 sm:text-xs',
              i === active
                ? `${d.tone.border} ${d.tone.text}`
                : 'border-transparent text-foreground/40 hover:text-foreground/70'
            )}
          >
            {d.label}
          </button>
        ))}
        <div className='ml-auto flex items-center gap-1'>
          <span className='inline-block size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.45)]' />
          <span className='pr-1 font-mono text-[10px] tracking-wider text-foreground/40 uppercase'>
            200 ok
          </span>
          <CopyButton text={curl} label={`复制 ${demo.label} curl`} />
        </div>
      </div>

      <div className='flex items-center gap-2.5 border-b border-border/40 px-5 py-3 dark:border-white/[0.04]'>
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider',
            demo.tone.badge
          )}
        >
          POST
        </span>
        <code className='truncate font-mono text-[12.5px] text-foreground/75'>
          {demo.path}
        </code>
      </div>

      <div className='font-mono text-[12.5px] leading-[1.6]'>
        <div className='min-h-[200px] px-5 py-4'>
          <span className='text-[10px] font-semibold tracking-[0.18em] text-foreground/30 uppercase'>
            Request
          </span>
          <div className='mt-2'>
            <div>
              <span className='font-medium text-emerald-600 dark:text-emerald-400'>
                curl
              </span>{' '}
              <span className='text-blue-600 dark:text-blue-400'>-X POST</span>{' '}
              <span className='text-amber-700 dark:text-amber-300'>
                "{baseUrl}
                {demo.path}"
              </span>{' '}
              <span className='text-foreground/55'>\</span>
            </div>
            <div className='ps-[2ch]'>
              <span className='text-blue-600 dark:text-blue-400'>-H</span>{' '}
              <span className='text-amber-700 dark:text-amber-300'>
                "{demo.auth}"
              </span>{' '}
              <span className='text-foreground/55'>\</span>
            </div>
            <div className='ps-[2ch]'>
              <span className='text-blue-600 dark:text-blue-400'>-d</span>{' '}
              <span className='text-amber-700 dark:text-amber-300'>'{'{'}</span>
            </div>
            {demo.body.map((line) => (
              <div key={line} className='ps-[4ch]'>
                <Json line={line} />
              </div>
            ))}
            <div className='ps-[2ch] text-amber-700 dark:text-amber-300'>
              {'}'}'
            </div>
          </div>
        </div>
        <div className='min-h-[150px] border-t border-border/40 bg-muted/20 px-5 py-4 dark:border-white/[0.05] dark:bg-white/[0.015]'>
          <span className='text-[10px] font-semibold tracking-[0.18em] text-foreground/30 uppercase'>
            Response
          </span>
          <div className='mt-2'>
            {demo.response.map((line, i) => (
              <Json key={i} line={line} />
            ))}
          </div>
        </div>
      </div>

      <div className='flex items-center justify-between border-t border-border/40 bg-muted/30 px-5 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.02]'>
        <span className='text-[10px] tracking-wider text-foreground/40 uppercase'>
          sk-vm-xxxx 为占位符
        </span>
        <span className='font-mono text-[10px] tracking-wider text-foreground/30 uppercase'>
          stream · sse
        </span>
      </div>
    </div>
  )
}
