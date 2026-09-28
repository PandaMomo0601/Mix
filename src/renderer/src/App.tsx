import { useEffect } from 'react'
import { useAuthStore } from '@renderer/stores/useAuthStore'
import { AuthForm } from './features/auth/AuthForm'
import { AuthFrame, Button, Feedback } from './features/auth/Controls'

function App(): React.JSX.Element {
  const snapshot = useAuthStore((s) => s.snapshot)
  useEffect(() => {
    const apply = useAuthStore.getState().apply
    const unsubscribe = window.mix.auth.onStateChange(apply)
    void window.mix.auth.getState().then(apply)
    return unsubscribe
  }, [])
  if (!snapshot || snapshot.status === 'starting')
    return <AuthFrame title="正在检查登录状态" description="请稍候…" />
  if (snapshot.status === 'signed-out') return <AuthForm snapshot={snapshot} />
  if (snapshot.status !== 'signed-in' || !snapshot.profile)
    return (
      <AuthFrame
        title={
          snapshot.status === 'connection-error'
            ? '暂时无法连接'
            : snapshot.status === 'storage-error'
              ? '无法读取本机登录信息'
              : '账号服务暂未就绪'
        }
      >
        <Feedback message={snapshot.message ?? '请稍后重试。'} error />
        <Button onClick={() => void window.mix.auth.retry()}>重试</Button>
        {snapshot.status !== 'configuration-error' && (
          <Button variant="secondary" onClick={() => void window.mix.auth.signOut()}>
            {snapshot.status === 'storage-error' ? '清除本机登录信息' : '退出当前设备'}
          </Button>
        )}
      </AuthFrame>
    )
  const profile = snapshot.profile
  return (
    <AuthFrame title="已登录 Mix" description="账号已就绪。这里将是你的工作区。">
      <div className="flex min-w-0 items-center gap-4">
        <div
          className="mix-avatar"
          role="img"
          aria-label="头像"
          style={profile.avatar ? { backgroundColor: profile.avatar.bg } : undefined}
        >
          {profile.avatar?.emoji ?? 'M'}
        </div>
        <div className="mix-feedback min-w-0 flex-1">
          <p className="truncate font-medium" title={profile.displayName}>
            {profile.displayName}
          </p>
          <p className="secondary break-all">{profile.email}</p>
        </div>
      </div>
      <Button variant="secondary" onClick={() => void window.mix.auth.signOut()}>
        退出当前设备
      </Button>
    </AuthFrame>
  )
}

export default App
