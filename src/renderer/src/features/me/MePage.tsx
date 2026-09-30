import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountProfile } from '../../../../shared/auth'
import { AuthFrame, Button, Feedback } from '../auth/Controls'
import { ProfileDialog } from './ProfileDialog'
import { KeysPage } from './KeysPage'
import { DeletionDialog } from './DeletionDialog'
import chatIcon from '../../assets/me/chat.svg'
import peopleIcon from '../../assets/me/people.svg'
import meIcon from '../../assets/me/me.svg'
import editIcon from '../../assets/me/edit.svg'
import { meCall } from './me-ui'

export function MePage({
  profile,
  onLogoutStart
}: {
  profile: AccountProfile
  onLogoutStart: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'account' | 'keys'>('account')
  const [edit, setEdit] = useState<'avatar' | 'nickname' | 'deletion' | null>(null)
  const [error, setError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState('')
  const alive = useRef(true)
  const revision = useRef(0)
  const readProfile = useCallback(async (): Promise<void> => {
    const run = ++revision.current
    const result = await meCall(window.mix.me.refreshProfile())
    if (!alive.current || revision.current !== run) return
    setReadError(result.ok ? '' : result.error.message)
    setReading(false)
  }, [])
  async function refresh(): Promise<void> {
    setReading(true)
    await readProfile()
  }
  useEffect(() => {
    alive.current = true
    void readProfile()
    return () => {
      alive.current = false
    }
  }, [readProfile])
  async function logout(): Promise<void> {
    setLoggingOut(true)
    onLogoutStart()
    const result = await window.mix.auth.signOut().catch(() => ({
      ok: false as const,
      error: { code: 'unknown', message: '退出结果尚未确认，请重试。' }
    }))
    if (!result.ok) {
      setError(
        result.error.code === 'connection'
          ? '连接暂时不可用，请检查网络后重试。账号及数据仍保留。'
          : result.error.message
      )
      setLoggingOut(false)
    }
  }
  const sections = (
    <nav aria-label="我的功能">
      <Button
        variant="text"
        className={tab === 'account' ? 'active' : ''}
        aria-current={tab === 'account' ? 'page' : undefined}
        onClick={() => setTab('account')}
        disabled={loggingOut}
      >
        账号信息
      </Button>
      <Button
        variant="text"
        className={tab === 'keys' ? 'active' : ''}
        aria-current={tab === 'keys' ? 'page' : undefined}
        onClick={() => setTab('keys')}
        disabled={loggingOut}
      >
        API Key
      </Button>
    </nav>
  )
  return (
    <div className="me-shell">
      <nav className="me-rail" aria-label="主导航">
        <div className="me-brand">Mix</div>
        <button
          className="me-rail-item"
          aria-label="对话（暂未开放）"
          title="对话（暂未开放）"
          disabled
        >
          <span className="me-rail-icon chat">
            <img src={chatIcon} alt="" />
          </span>
          <span>对话</span>
        </button>
        <button
          className="me-rail-item"
          aria-label="联系人（暂未开放）"
          title="联系人（暂未开放）"
          disabled
        >
          <span className="me-rail-icon people">
            <img src={peopleIcon} alt="" />
          </span>
          <span>联系人</span>
        </button>
        <div className="me-rail-spacer" />
        <button className="me-rail-item selected" aria-current="page">
          <span className="me-rail-icon me">
            <img src={meIcon} alt="" />
          </span>
          <span>我</span>
        </button>
      </nav>
      <aside className="me-sections">
        <h2>我</h2>
        {sections}
      </aside>
      <main className="me-main">
        <div className="me-content">
          <div className="me-mobile-sections">{sections}</div>
          {tab === 'keys' ? (
            <KeysPage />
          ) : (
            <>
              <header className="me-page-heading">
                <h1>账号信息</h1>
                <p className="secondary">你在 Mix 与 MixChat 中共用的账号。</p>
              </header>
              {reading ? (
                <Feedback title="正在读取账号信息" message="请稍候。" />
              ) : readError ? (
                <>
                  <Feedback
                    title="账号信息暂时无法读取"
                    message="请检查网络后重试。API Key 管理仍可独立访问。"
                    error
                  />
                  <Button
                    variant="secondary"
                    className="me-list-retry"
                    onClick={() => void refresh()}
                  >
                    重新读取
                  </Button>
                  <Button
                    variant="text"
                    className="me-read-error-logout"
                    onClick={() => void logout()}
                    disabled={loggingOut}
                  >
                    退出当前设备
                  </Button>
                </>
              ) : (
                <>
                  <div className="me-profile-summary">
                    <button
                      className="mix-avatar me-avatar-edit"
                      aria-label="更换头像"
                      title="更换头像"
                      style={profile.avatar ? { backgroundColor: profile.avatar.bg } : undefined}
                      onClick={() => setEdit('avatar')}
                    >
                      <span>{profile.avatar?.emoji ?? 'M'}</span>
                      <span className="me-avatar-overlay">
                        <img src={editIcon} alt="" />
                      </span>
                    </button>
                    <div className="me-profile-identity">
                      <div className="me-name-row">
                        <p className="me-name-text">{profile.displayName}</p>
                        <span className="me-name-icon-slot">
                          <button
                            className="me-name-edit"
                            aria-label="修改昵称"
                            title="修改昵称"
                            disabled={loggingOut}
                            onClick={() => setEdit('nickname')}
                          >
                            <img src={editIcon} alt="" />
                          </button>
                        </span>
                      </div>
                      <p className="me-caption">个人账号</p>
                    </div>
                  </div>
                  <dl className="me-account-data">
                    <div>
                      <dt>登录邮箱</dt>
                      <dd>{profile.email}</dd>
                    </div>
                    <div>
                      <dt>邮箱状态</dt>
                      <dd>{profile.emailConfirmedAt ? '已确认' : '暂未确认'}</dd>
                    </div>
                  </dl>
                  <section className="me-account-action">
                    <div>
                      <h2>当前设备</h2>
                      <p className="secondary">退出只影响这台设备。</p>
                    </div>
                    <Button variant="secondary" onClick={() => void logout()} disabled={loggingOut}>
                      {loggingOut ? '正在退出…' : '退出当前设备'}
                    </Button>
                  </section>
                  {error && <Feedback title="退出未完成" message={error} error />}
                  <hr className="me-rule" />
                  <section className="me-account-action me-deletion-action">
                    <div>
                      <h2>账号注销</h2>
                      <p className="me-caption">永久删除两端共用账号及关联数据。</p>
                    </div>
                    <Button variant="text" onClick={() => setEdit('deletion')}>
                      注销账号
                    </Button>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </main>
      {(edit === 'avatar' || edit === 'nickname') && (
        <ProfileDialog key={edit} kind={edit} profile={profile} onClose={() => setEdit(null)} />
      )}
      {edit === 'deletion' && <DeletionDialog onClose={() => setEdit(null)} />}
      {loggingOut &&
        createPortal(
          <div className="me-deletion-screen">
            <AuthFrame
              variant="me-result"
              title="正在退出当前设备"
              description="请稍候，正在结束本机登录会话。"
            />
          </div>,
          document.body
        )}
    </div>
  )
}
