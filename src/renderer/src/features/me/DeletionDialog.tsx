import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AuthFrame, Button, Field, Feedback as DeletionFeedback } from '../auth/Controls'
import { createPortal } from 'react-dom'
import { Dialog } from './Dialog'
import { meCall } from './me-ui'

export function DeletionDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<'reauth' | 'verifying' | 'final' | 'pending' | 'unknown'>(
    'reauth'
  )
  const [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function verify(): Promise<void> {
    if (!password) {
      setError('请输入当前密码后继续。账号和数据尚未删除。')
      return
    }
    setPhase('verifying')
    setError('')
    const result = await meCall(window.mix.me.reauthenticateForDeletion(password))
    if (!alive.current) return
    if (result.ok) setPhase('final')
    else {
      if (result.error.code === 'reauthentication_failed') setPassword('')
      setError(
        result.error.code === 'reauthentication_failed'
          ? '请检查当前密码后重试。账号和数据尚未删除。'
          : result.error.message
      )
      setPhase('reauth')
    }
  }
  async function submit(): Promise<void> {
    setPhase('pending')
    setError('')
    const result = await meCall(
      window.mix.me.requestAccountDeletion({
        requestId: requestId.current,
        password,
        confirmed: true,
        scopeVersion: 'shared-account-v1'
      })
    )
    if (!alive.current) return
    setPassword('')
    if (!result.ok) {
      setError(result.error.message)
      setPhase(
        ['unknown', 'validation_timeout', 'provider_unavailable'].includes(result.error.code)
          ? 'unknown'
          : 'reauth'
      )
    }
  }
  async function check(): Promise<void> {
    setPhase('pending')
    const result = await meCall(window.mix.me.getDeletionStatus())
    if (!alive.current) return
    if (result.ok && result.data) onClose()
    else {
      setPhase('unknown')
      setError(result.ok ? '尚未找到受理回执，请核对后再决定是否重试。' : result.error.message)
    }
  }
  const verifying = phase === 'verifying'
  const pending = phase === 'pending'
  const final = phase === 'final'
  if (pending || phase === 'unknown')
    return createPortal(
      <div className="me-deletion-screen">
        <AuthFrame
          variant="me-result"
          title={pending ? '正在注销账号' : '正在核实注销结果'}
          description={
            pending
              ? '正在删除两端共用账号及关联数据，请稍候。'
              : '连接中断，暂时无法确认是否已全部完成。请查看处理结果。'
          }
        >
          {pending ? (
            <p className="me-caption">无需重新登录即可核验这次注销结果。</p>
          ) : (
            <>
              <Button onClick={() => void check()}>查看处理结果</Button>
              <p className="me-caption">无需重新登录即可核验这次注销结果。</p>
            </>
          )}
        </AuthFrame>
      </div>,
      document.body
    )
  return (
    <Dialog
      title={final ? '确认永久注销？' : '注销共用账号'}
      onClose={onClose}
      busy={pending || verifying}
      className={`me-dialog-deletion ${final ? 'me-deletion-final' : ''}`}
      height={final ? 332 : error ? 566 : 466}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={verifying}>
            取消
          </Button>
          <Button onClick={() => (final ? void submit() : void verify())} disabled={verifying}>
            {final ? '注销账号' : verifying ? '正在验证…' : '验证身份并继续'}
          </Button>
        </>
      }
    >
      {final ? (
        <>
          <p>你已完成身份验证。</p>
          <p>确认后，Mix 与 MixChat 的共用账号及关联数据将被永久删除，两端会话将停止访问。</p>
          <DeletionFeedback title="无法撤销" message="请确认已经保存需要保留的内容。" />
        </>
      ) : (
        <>
          <DeletionFeedback
            title="此操作无法恢复"
            message="将删除你在 Mix（PC端）与 MixChat（Web端）的共用账号及关联数据。两端均将无法继续使用此账号。"
          />
          <p>
            包括账号资料、机器人与会话、消息、知识文档与附件，以及产品内保存的 API Key 接入和凭据。
          </p>
          <p className="me-caption">第三方服务商账号及其原始 Key 不会被注销。</p>
          {error && <DeletionFeedback title="身份验证未通过" message={error} error />}
          {
            <Field
              name="me-delete-password"
              label="当前密码"
              type="password"
              passwordToggle={false}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={verifying || pending}
              invalid={Boolean(error)}
              placeholder="请输入当前密码"
              hint="验证身份后，还需要进行最后一次确认。"
            />
          }
        </>
      )}
    </Dialog>
  )
}
export function DeletionReceipt({
  children,
  onLogin
}: {
  children: ReactNode
  onLogin: () => void
}): React.JSX.Element {
  const [state, setState] = useState<{
    phase: string
    cleanupFailed: boolean
    nextPoll: number
  } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(true)
  const alive = useRef(true)
  const poll = useCallback(
    (): Promise<void> =>
      meCall(window.mix.me.getDeletionStatus()).then((result) => {
        if (!alive.current) return
        setBusy(false)
        if (result.ok)
          setState(
            result.data
              ? {
                  phase: result.data.phase,
                  cleanupFailed: result.data.localCleanup === 'failed',
                  nextPoll: result.data.nextPollAfter
                }
              : null
          )
        else
          setState((s) => ({
            phase: 'unknown',
            cleanupFailed: s?.cleanupFailed ?? false,
            nextPoll: 0
          }))
      }),
    []
  )
  async function refreshReceipt(): Promise<void> {
    setBusy(true)
    await poll()
  }
  useEffect(() => {
    alive.current = true
    void poll()
    return () => {
      alive.current = false
    }
  }, [poll])
  useEffect(() => {
    if (dismissed || state?.phase !== 'processing' || busy) return
    const timer = setTimeout(
      () => {
        setBusy(true)
        void poll()
      },
      Math.max(5, state.nextPoll) * 1000
    )
    return () => clearTimeout(timer)
  }, [state, busy, dismissed, poll])
  if (!state || dismissed) return <>{children}</>
  const phase = state.cleanupFailed ? 'needs_attention' : state.phase
  const description =
    phase === 'completed'
      ? 'Mix 与 MixChat 的共用账号及关联数据已删除。'
      : phase === 'needs_attention'
        ? '部分数据仍在处理中，请重试清理。两端会话已停止访问。'
        : phase === 'unknown'
          ? '连接中断，暂时无法确认是否已全部完成。请查看处理结果。'
          : phase === 'expired'
            ? '回执已过期，无法据此确认注销结果。'
            : '正在删除两端共用账号及关联数据，请稍候。'
  return (
    <AuthFrame
      variant="me-result"
      title={
        phase === 'completed'
          ? '账号已注销'
          : phase === 'needs_attention'
            ? '注销尚未完成'
            : phase === 'unknown'
              ? '正在核实注销结果'
              : phase === 'expired'
                ? '注销回执已过期'
                : '正在注销账号'
      }
      description={description}
    >
      {phase === 'processing' ? (
        <p className="me-caption">无需重新登录即可核验这次注销结果。</p>
      ) : (
        <Button
          disabled={busy}
          onClick={
            phase === 'completed' || phase === 'expired'
              ? () => {
                  setDismissed(true)
                  onLogin()
                }
              : () => void refreshReceipt()
          }
        >
          {busy
            ? '正在核对…'
            : phase === 'completed'
              ? '前往登录'
              : phase === 'expired'
                ? '返回登录'
                : phase === 'needs_attention'
                  ? '重试清理'
                  : '查看处理结果'}
        </Button>
      )}
      {['unknown', 'needs_attention'].includes(phase) && (
        <p className="me-caption">无需重新登录即可核验这次注销结果。</p>
      )}
    </AuthFrame>
  )
}
