import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { CopyChip } from '@/components/copy-chip'
import { modelsQueryOptions } from '@/features/models/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'

/** Client-facing entry: the base URLs keys call, and every model id they may send. */
export function EntryStrip() {
  const dash = useQuery(dashboardQueryOptions())
  const models = useQuery(modelsQueryOptions())
  const base = String(dash.data?.health?.base_url || location.origin).replace(
    /\/$/,
    ''
  )
  const ids = (models.data?.items || []).map((m) => m.id)

  return (
    <Collapsible className='mb-5 rounded-xl border bg-card'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5'>
        <span className='text-sm font-medium'>接入</span>
        <div className='flex min-w-0 flex-1 flex-wrap items-center gap-1.5'>
          <CopyChip text={`${base}/v1`} />
          <CopyChip text={`${base}/v1/messages`} />
        </div>
        <CollapsibleTrigger
          disabled={!ids.length}
          className='flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-60 data-[state=open]:[&_svg]:rotate-180'
        >
          {models.isLoading
            ? '读取模型 id'
            : ids.length
              ? `可用模型 id ${ids.length}`
              : '还没有可用模型'}
          <ChevronDown
            className='size-3.5 transition-transform duration-200 motion-reduce:transition-none'
            aria-hidden='true'
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className='border-t px-4 py-3'>
        <div className='flex flex-wrap gap-1.5'>
          {ids.map((id) => (
            <CopyChip key={id} text={id} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
