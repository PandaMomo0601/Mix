import { useEffect, useState } from 'react'
import type { AccountProfile, AuthSnapshot } from '../../shared/auth'
import { useAuthStore } from '@renderer/stores/useAuthStore'
import { AuthForm } from './features/auth/AuthForm'
import { AuthFrame, Button, Feedback } from './features/auth/Controls'
import { MePage } from './features/me/MePage'
import { DeletionReceipt } from './features/me/DeletionDialog'

function App(): React.JSX.Element {
  const snapshot = useAuthStore((s) => s.snapshot)
  const [logoutProfile, setLogoutProfile] = useState<AccountProfile | null>(null)
  const [loginEntryRevision, setLoginEntryRevision] = useState<number | null>(null)
  useEffect(() => {
    const apply = useAuthStore.getState().apply
    const receive = (next: AuthSnapshot): void => {
      apply(next)
      if (next.status !== 'starting') setLogoutProfile(null)
    }
    const unsubscribe = window.mix.auth.onStateChange(receive)
    void window.mix.auth.getState().then(receive)
    return unsubscribe
  }, [])
  if (snapshot?.status === 'starting' && logoutProfile)
    return <MePage key={logoutProfile.id} profile={logoutProfile} onLogoutStart={() => {}} />
  if (!snapshot || snapshot.status === 'starting')
    return <AuthFrame title="正在检查登录状态" description="请稍候…" />
  if (snapshot.status === 'signed-out')
    return (
      <DeletionReceipt onLogin={() => setLoginEntryRevision(snapshot.revision)}>
        {loginEntryRevision !== snapshot.revision &&
        snapshot.message &&
        (snapshot.message.includes('已退出') || snapshot.message.includes('登录已失效')) ? (
          <AuthFrame
            variant="me-result"
            title={snapshot.message.includes('登录已失效') ? '登录已失效' : '已退出当前设备'}
            description={
              snapshot.message.includes('登录已失效')
                ? '请重新登录后继续。'
                : '云端账号和接入仍然保留。'
            }
          >
            <Button onClick={() => setLoginEntryRevision(snapshot.revision)}>前往登录</Button>
          </AuthFrame>
        ) : (
          <AuthForm
            snapshot={{
              ...snapshot,
              message: loginEntryRevision === snapshot.revision ? null : snapshot.message
            }}
          />
        )}
      </DeletionReceipt>
    )
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
    <MePage key={profile.id} profile={profile} onLogoutStart={() => setLogoutProfile(profile)} />
  )
}

export default App
