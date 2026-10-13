import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasSession } from '@/lib/session'
import { LoginPage } from '@/features/auth/login-page'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' && search.redirect
      ? { redirect: search.redirect }
      : {},
  beforeLoad: () => {
    if (hasSession()) throw redirect({ to: '/' })
  },
  component: LoginPage,
})
