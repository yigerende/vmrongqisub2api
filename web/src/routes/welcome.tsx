import { createFileRoute } from '@tanstack/react-router'
import { WelcomePage } from '@/features/welcome'

export const Route = createFileRoute('/welcome')({
  validateSearch: (search: Record<string, unknown>) =>
    [true, 1, '1', 'true'].includes(search.setup as never)
      ? { setup: true as const }
      : {},
  component: WelcomePage,
})
