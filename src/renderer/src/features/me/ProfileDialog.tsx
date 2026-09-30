import { useEffect, useRef, useState } from 'react'
import type { AccountProfile } from '../../../../shared/auth'
import { AVATAR_EMOJI, avatarFor } from '../../../../shared/profile'
import { normalizeName } from '../../../../shared/me-validation'
import { Button, Feedback } from '../auth/Controls'
import { Dialog } from './Dialog'
import { meCall } from './me-ui'

export function ProfileDialog({
  kind,
  profile,
  onClose
}: {
  kind: 'avatar' | 'nickname'
  profile: AccountProfile
  onClose: () => void
}): React.JSX.Element {
  const [initial, setInitial] = useState(profile)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [nickname, setNickname] = useState(profile.nickname ?? '')
  const [avatar, setAvatar] = useState(profile.avatar)
  const [phase, setPhase] = useState<
    'editing' | 'saving' | 'done' | 'error' | 'unknown' | 'syncing'
  >('editing')
  const [message, setMessage] = useState('')
  const [fieldError, setFieldError] = useState('')
  const isNickname = kind === 'nickname'
  const noun = isNickname ? '昵称' : '头像'
  const busy = phase === 'saving'
  const unchanged = isNickname
    ? nickname.trim() === (initial.nickname ?? '')
    : JSON.stringify(avatar) === JSON.stringify(initial.avatar)
  const remoteChanged = isNickname
    ? profile.nickname !== initial.nickname
    : JSON.stringify(profile.avatar) !== JSON.stringify(initial.avatar)
  const resultRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (['done', 'unknown', 'syncing'].includes(phase)) resultRef.current?.focus()
  }, [phase])
  async function save(): Promise<void> {
    setFieldError('')
    if (isNickname)
      try {
        normalizeName(nickname)
      } catch {
        setFieldError(
          !nickname.trim()
            ? '请输入昵称，不能只填写空格。'
            : Array.from(nickname.trim()).length > 40
              ? '昵称不能超过40个字符，请缩短后保存。'
              : '昵称不能包含换行或控制字符。'
        )
        return
      }
    if (!isNickname && !avatar) return
    setPhase('saving')
    const result = isNickname
      ? await meCall(window.mix.me.updateNickname(nickname))
      : await meCall(window.mix.me.updateAvatar(avatar!))
    if (!alive.current) return
    if (result.ok) {
      setNickname(result.data.profile.nickname ?? '')
      setAvatar(result.data.profile.avatar)
      setPhase(result.data.outcome === 'syncing' ? 'syncing' : 'done')
    } else {
      setPhase(result.error.code === 'unknown' ? 'unknown' : 'error')
      setMessage(
        ['provider_unavailable', 'validation_timeout', 'unknown'].includes(result.error.code)
          ? ''
          : result.error.message
      )
    }
  }
  async function check(adopt = false): Promise<void> {
    const previous = phase
    setPhase('saving')
    const result = await meCall(window.mix.me.refreshProfile())
    if (!alive.current) return
    if (result.ok && adopt) {
      setInitial(result.data)
      setNickname(result.data.nickname ?? '')
      setAvatar(result.data.avatar)
      setPhase('editing')
      setMessage('')
      setFieldError('')
      return
    }
    const same =
      result.ok &&
      (isNickname
        ? result.data.nickname === nickname.trim()
        : JSON.stringify(result.data.avatar) === JSON.stringify(avatar))
    setPhase(
      same
        ? 'done'
        : !result.ok && previous === 'syncing'
          ? 'syncing'
          : !result.ok && previous === 'unknown'
            ? 'unknown'
            : 'error'
    )
    setMessage(result.ok && !same ? '当前资料与草稿不同，请核对后再保存。' : '')
  }
  const avatarView = (
    <div className="mix-avatar" style={avatar ? { backgroundColor: avatar.bg } : undefined}>
      {avatar?.emoji ?? 'M'}
    </div>
  )
  const title = busy
    ? `正在保存${noun}`
    : phase === 'unknown'
      ? '核实保存结果'
      : isNickname
        ? '修改昵称'
        : '更换头像'
  const result = ['done', 'syncing', 'unknown'].includes(phase)
  return (
    <Dialog
      title={title}
      variant="profile"
      height={
        isNickname ? (remoteChanged && !result && !busy ? 480 : 400) : result || busy ? 340 : 520
      }
      className={[
        isNickname && (result || busy) ? 'me-dialog-nickname-result' : '',
        phase === 'unknown' ? 'me-dialog-profile-unknown' : '',
        remoteChanged && !result && !busy ? 'me-dialog-profile-remote' : ''
      ].join(' ')}
      onClose={onClose}
      busy={busy}
      footer={
        busy ? (
          <Button disabled>保存中…</Button>
        ) : phase === 'done' ? (
          <Button onClick={onClose}>完成</Button>
        ) : phase === 'syncing' ? (
          <Button onClick={() => void check()}>重新获取资料</Button>
        ) : phase === 'unknown' ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              稍后核对
            </Button>
            <Button onClick={() => void check()}>核对最新资料</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={remoteChanged ? () => void check(true) : onClose}>
              {remoteChanged ? '使用最新资料' : '取消'}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={unchanged || Boolean(fieldError) || (!isNickname && !avatar)}
            >{`保存${noun}`}</Button>
          </>
        )
      }
    >
      {busy ? (
        <Feedback title={`正在保存${noun}`} message="正在更新你的共用账号资料，请稍候。" />
      ) : result ? (
        <>
          <div ref={resultRef} tabIndex={-1}>
            <Feedback
              title={
                phase === 'unknown'
                  ? `暂时无法确认${noun}是否已保存`
                  : phase === 'syncing'
                    ? `${noun}已保存，页面暂未刷新`
                    : `${noun}已更新`
              }
              message={
                phase === 'unknown' ? (
                  isNickname ? (
                    '网络连接中断。本次昵称草稿已保留，先核对最新资料，避免重复提交。'
                  ) : (
                    '本次选择已保留。先核对最新资料，再决定是否重新保存。'
                  )
                ) : phase === 'syncing' ? (
                  `请重新获取账号资料，无需再次提交${noun}。`
                ) : (
                  <>
                    {isNickname ? '头像保持原样。' : '昵称保持原样。'}
                    <span className="me-profile-wide-copy">
                      Mix 和 MixChat 使用同一份账号资料。
                    </span>
                  </>
                )
              }
            />
          </div>
          {isNickname ? (
            <>
              {phase === 'unknown' && <p className="me-label">本次昵称：</p>}
              <p className={phase === 'unknown' ? '' : 'me-dialog-title-text'}>{nickname}</p>
            </>
          ) : (
            <div className="me-avatar-preview">
              {avatarView}
              {phase === 'done' && <p className="me-label me-profile-wide-copy">你的新头像</p>}
            </div>
          )}
        </>
      ) : (
        <>
          {phase === 'error' ? (
            <Feedback
              title={`${noun}未保存`}
              message={
                message ||
                (isNickname
                  ? '暂时无法连接服务器。你的输入已保留，可以重试。'
                  : '暂时无法连接服务器。当前选择已保留，可以重试。')
              }
              error
            />
          ) : (
            remoteChanged && (
              <Feedback
                title={isNickname ? '其他设备修改了昵称' : '其他设备更换了头像'}
                message={
                  isNickname
                    ? '你的草稿仍保留。继续保存将以本次昵称更新账号资料；也可以使用最新资料。'
                    : '当前选择仍保留。继续保存将使用本次选择，也可以使用最新资料。'
                }
              />
            )
          )}
          {isNickname ? (
            <>
              <NicknameField
                value={nickname}
                onChange={(value) => {
                  setNickname(value)
                  setFieldError('')
                }}
                error={fieldError}
              />
              <p className="me-caption">保存后，Mix 和 MixChat 共用这个昵称。</p>
            </>
          ) : (
            <>
              <div className="me-avatar-preview">
                {avatarView}
                <div>
                  <p className="me-label">当前选择</p>
                  <p className="me-caption">点击保存后更新头像</p>
                </div>
              </div>
              <p className="me-label">选择一个头像</p>
              <div className="me-avatar-grid" role="group" aria-label="预设头像">
                {AVATAR_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="me-avatar-option"
                    aria-label={`选择头像 ${emoji}`}
                    aria-pressed={avatar?.emoji === emoji}
                    style={{ backgroundColor: avatarFor(emoji)!.bg }}
                    onClick={() => setAvatar(avatarFor(emoji))}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Dialog>
  )
}

function NicknameField({
  value,
  error,
  onChange
}: {
  value: string
  error: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const wrap = error === '昵称不能超过40个字符，请缩短后保存。'
  return (
    <div className="mix-field flex flex-col gap-2">
      <label htmlFor="me-nickname">昵称</label>
      <div className={`mix-input me-nickname-input ${error ? 'invalid' : ''}`}>
        <textarea
          id="me-nickname"
          name="me-nickname"
          className={wrap ? 'me-nickname-wrap' : ''}
          rows={1}
          value={value}
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby="me-nickname-hint"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <p className="field-hint" id="me-nickname-hint">
        {error || '1—40个字符，可与其他人重名。'}
      </p>
    </div>
  )
}
