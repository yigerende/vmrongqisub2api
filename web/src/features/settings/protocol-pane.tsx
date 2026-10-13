import { Boxes, Check, ShieldCheck } from 'lucide-react'
import { detectProxiedOfficialCcFromCompat } from '@/lib/cache-breakpoints'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>

/** Mirrors `hasClaudeCodeClientHeaders` + body checks in src/lib/identity/claude-code-only.mjs. */
const CLAUDE_CODE_FINGERPRINT: [string, string][] = [
  ['UA', 'claude-cli/x.y.z'],
  ['x-app', 'cli'],
  ['anthropic-beta', 'claude-code-20250219'],
  ['Stainless SDK', 'x-stainless-lang: js'],
  ['会话头', '= user_id.session_id'],
  ['system', '官方计费块 / 身份行'],
  ['计费块', 'cc_version = UA 版本'],
]

function codexClient(codex: Block, key: string) {
  const clients = (codex.clients as Record<string, unknown>) || {}
  return clients[key] === 'allow'
}

function codexProtocol(codex: Block, key: string) {
  const protocols =
    (codex.protocols as Record<string, Record<string, unknown>>) || {}
  return protocols[key] || {}
}

function RowGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className='min-w-0 space-y-2'>
      <h4 className='text-xs font-medium text-muted-foreground'>{title}</h4>
      <div className='divide-y'>{children}</div>
    </section>
  )
}

function AdmissionSection({
  compat,
  codex,
  onCompatChange,
  onCodexChange,
}: {
  compat: Block
  codex: Block
  onCompatChange: (next: Block) => void
  onCodexChange: (next: Block) => void
}) {
  const strict = compat.claude_code_only === true
  const relay = detectProxiedOfficialCcFromCompat(compat)
  const setClient = (key: string, allow: boolean) =>
    onCodexChange({
      ...codex,
      clients: {
        ...((codex.clients as object) || {}),
        [key]: allow ? 'allow' : 'reject',
      },
    })

  return (
    <PaneSection
      icon={ShieldCheck}
      title='入站准入'
      desc='谁能调用。按请求的模型平台分别生效。'
      aside={
        <Badge variant={strict ? 'default' : 'secondary'}>
          {strict ? 'Claude 仅限 Claude Code' : 'Claude 不限客户端'}
        </Badge>
      }
    >
      <div className='grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <RowGroup title='Claude 模型'>
          <SettingRow
            label='仅允许 Claude Code 家族请求'
            desc='其余一律 403 claude_code_only，不选号、不上游。'
          >
            <Switch
              checked={strict}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, claude_code_only: on })
              }
              aria-label='仅允许 Claude Code 家族请求'
            />
          </SettingRow>
          <SettingRow
            label='识别中转来的官方 Claude Code'
            desc={
              relay
                ? 'UA 被改写但系统里有官方计费块的请求按官方处理，准入也放行。计费块被丢掉时，还要官方 system 和合法 user_id。'
                : '已关：只认直连 Claude Code，中转流量按第三方处理。'
            }
          >
            <Switch
              checked={relay}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label='识别中转来的官方 Claude Code'
            />
          </SettingRow>
          <div
            className={cn(
              'space-y-3 pt-3 transition-opacity duration-200',
              !strict && 'opacity-55'
            )}
          >
            <p className='text-xs text-muted-foreground'>
              {strict ? '直连放行须同时满足' : '开启后直连放行须同时满足'}
            </p>
            <ul className='grid gap-x-4 gap-y-1.5 sm:grid-cols-2'>
              {CLAUDE_CODE_FINGERPRINT.map(([name, value]) => (
                <li
                  key={name}
                  className='flex min-w-0 items-start gap-2 text-xs'
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      strict ? 'text-primary' : 'text-muted-foreground'
                    )}
                    aria-hidden
                  />
                  <span className='min-w-0'>
                    <span className='font-medium'>{name}</span>{' '}
                    <span className='font-mono break-all text-muted-foreground'>
                      {value}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className='text-xs leading-5 text-muted-foreground'>
              OpenAI 格式入口与健康探测一律拒绝。count_tokens 只验请求头；CLI
              自身的 quota 探测须是固定原样。面板测试与内部探测不受影响。
            </p>
          </div>
        </RowGroup>

        <RowGroup title='GPT 模型'>
          <SettingRow label='官方 Codex 客户端'>
            <Switch
              checked={codexClient(codex, 'official_codex')}
              onCheckedChange={(allow) => setClient('official_codex', allow)}
              aria-label='允许官方 Codex 客户端'
            />
          </SettingRow>
          <SettingRow label='OpenAI 兼容客户端'>
            <Switch
              checked={codexClient(codex, 'openai_compatible')}
              onCheckedChange={(allow) => setClient('openai_compatible', allow)}
              aria-label='允许 OpenAI 兼容客户端'
            />
          </SettingRow>
          <SettingRow
            label='拒绝 Claude Code 客户端'
            desc='GPT 槽不走 Claude Code。'
          >
            <Switch
              checked={!codexClient(codex, 'claude_code')}
              onCheckedChange={(reject) => setClient('claude_code', !reject)}
              aria-label='GPT 模型拒绝 Claude Code 客户端'
            />
          </SettingRow>
        </RowGroup>
      </div>
    </PaneSection>
  )
}

function GptRouteSection({
  codex,
  onCodexChange,
}: {
  codex: Block
  onCodexChange: (next: Block) => void
}) {
  const enabled = codex.enabled !== false
  const convert = (codex.convert as Block) || {}
  const update = (patch: Block) => onCodexChange({ ...codex, ...patch })
  const setProtocol = (key: string, on: boolean, mode: string) =>
    update({
      protocols: {
        ...((codex.protocols as object) || {}),
        [key]: { mode, enabled: on },
      },
    })

  return (
    <PaneSection
      icon={Boxes}
      title='GPT 链路'
      desc={
        enabled
          ? 'gpt-* 进 codex-kernel。'
          : '已关：gpt-* 请求 4xx，不回落 Claude。'
      }
      aside={
        <Switch
          checked={enabled}
          onCheckedChange={(on) => update({ enabled: on })}
          aria-label='启用 GPT 路由'
        />
      }
    >
      <div
        className={cn(
          'divide-y transition-opacity duration-200',
          !enabled && 'opacity-55'
        )}
      >
        <SettingRow label='/v1/responses' desc='ChatGPT native。'>
          <Switch
            checked={codexProtocol(codex, 'openai.responses').enabled !== false}
            onCheckedChange={(on) =>
              setProtocol('openai.responses', on, 'native')
            }
            aria-label='/v1/responses'
          />
        </SettingRow>
        <SettingRow label='Chat 转 Codex Responses'>
          <Switch
            checked={convert.chat_to_codex !== false}
            onCheckedChange={(chat_to_codex) =>
              update({ convert: { ...convert, chat_to_codex } })
            }
            aria-label='Chat 转 Codex Responses'
          />
        </SettingRow>
        <SettingRow label='Completions 转 Codex'>
          <Switch
            checked={convert.completions_to_codex !== false}
            onCheckedChange={(completions_to_codex) =>
              update({ convert: { ...convert, completions_to_codex } })
            }
            aria-label='Completions 转 Codex'
          />
        </SettingRow>
        <SettingRow
          label='Codex 目录客户端版本'
          desc='auto 取官方 @openai/codex 版本并缓存，失败用 0.160.0。'
        >
          <Input
            className='w-28'
            maxLength={20}
            value={String(codex.catalog_client_version ?? 'auto')}
            placeholder='auto'
            aria-label='Codex 目录客户端版本'
            onChange={(e) =>
              update({ catalog_client_version: e.target.value || 'auto' })
            }
          />
        </SettingRow>
      </div>
    </PaneSection>
  )
}

export function ProtocolPane({
  compat,
  codex,
  onCompatChange,
  onCodexChange,
}: {
  compat: Block
  codex: Block
  onCompatChange: (next: Block) => void
  onCodexChange: (next: Block) => void
}) {
  return (
    <div className='space-y-4'>
      <AdmissionSection
        compat={compat}
        codex={codex}
        onCompatChange={onCompatChange}
        onCodexChange={onCodexChange}
      />
      <GptRouteSection codex={codex} onCodexChange={onCodexChange} />
    </div>
  )
}
