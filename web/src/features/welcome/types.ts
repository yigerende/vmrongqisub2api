export type OnboardingStatus = 'pending' | 'completed' | 'dismissed'

export type OnboardingAction = 'complete' | 'dismiss' | 'reset'

export type OnboardingStep = {
  id: string
  done: boolean
}

export type OnboardingPayload = {
  user: string
  role: string
  status: OnboardingStatus
  updated_at: string | null
  needs_welcome: boolean
  base_url: string | null
  steps: OnboardingStep[]
  done_count: number
  total: number
}
