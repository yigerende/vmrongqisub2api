import { useNavigate } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const signOut = useAuthStore((s) => s.signOut)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='退出登录'
      desc='退出后需要重新登录才能管理号池。'
      confirmText='退出'
      cancelBtnText='取消'
      destructive
      handleConfirm={() => {
        signOut()
        navigate({
          to: '/welcome',
          search: {},
          replace: true,
        })
      }}
      className='sm:max-w-sm'
    />
  )
}
