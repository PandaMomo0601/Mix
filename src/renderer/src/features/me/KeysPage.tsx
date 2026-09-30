import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionList, ConnectionSummary } from '../../../../shared/me'
import { Button, Feedback } from '../auth/Controls'
import { KeyDialog } from './KeyDialog'
import { providerLabels, meCall, type KeyMode } from './me-ui'

function connectionStatus(c: ConnectionSummary): string {
  if (c.localCredentialState === 'stale') return '本机 Key 已过期 · 需要补填'
  if (c.localCredentialState === 'missing') return '本机未保存 Key · 需要补填'
  if (c.localCredentialState === 'locked') return '本机安全存储暂不可用'
  if (c.localCredentialState === 'error') return '本机 Key 保存尚未完成'
  if (c.status === 'invalid') return '已失效 · 请更换 API Key'
  if (c.status === 'unavailable') return '暂不可用 · 请重新验证'
  return c.status === 'verified' ? '本机可用 · 最近验证通过' : '本机可用 · 尚未确认验证结果'
}
export function KeysPage(): React.JSX.Element {
  const [list, setList] = useState<ConnectionList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<{ title: string; message: string } | null>(null)
  const [dialog, setDialog] = useState<{ mode: KeyMode; connection?: ConnectionSummary } | null>(
    null
  )
  const alive = useRef(true)
  const revision = useRef(0)
  const readList = useCallback((): Promise<ConnectionList | null> => {
    const run = ++revision.current
    return meCall(window.mix.me.listConnections()).then((result) => {
      if (!alive.current || revision.current !== run) return null
      setLoading(false)
      if (result.ok) {
        setList(result.data)
        setError('')
        return result.data
      }
      setError(result.error.message)
      return null
    })
  }, [])
  async function reload(): Promise<ConnectionList | null> {
    setLoading(true)
    return readList()
  }
  useEffect(() => {
    alive.current = true
    void readList()
    return () => {
      alive.current = false
    }
  }, [readList])
  const stale = list?.connections.some((c) => c.localCredentialState === 'stale')
  const missing = list?.connections.some((c) => c.localCredentialState === 'missing')
  const open = (mode: KeyMode, connection?: ConnectionSummary): void => {
    setSuccess(null)
    setDialog({ mode, connection })
  }
  async function add(): Promise<void> {
    const ready = error || loading || !list ? await reload() : list
    if (ready && alive.current) open('add')
  }
  const retry = (
    <Button
      variant="secondary"
      className="me-list-retry"
      onClick={() => void reload()}
      disabled={loading}
    >
      {list ? '重新连接' : '重新读取'}
    </Button>
  )
  return (
    <>
      <header className="me-key-heading">
        <div className="me-page-heading">
          <h1>API Key</h1>
          <p className="secondary">管理你自己的模型接入。</p>
        </div>
        {(Boolean(list?.connections.length) || loading || Boolean(error)) && (
          <Button onClick={() => void add()}>添加接入</Button>
        )}
      </header>
      {loading && !list && <Feedback title="正在读取接入列表" message="请稍候。" />}
      {error ? (
        <Feedback
          title={list ? '当前离线' : '接入列表暂时无法读取'}
          message={
            list
              ? '以下为上次读取的内容。联网后可刷新；当前无法验证或保存修改。'
              : '请检查网络后重试。已有接入不会因此被删除。'
          }
          error
        />
      ) : success ? (
        <Feedback title={success.title} message={success.message} />
      ) : stale ? (
        <Feedback
          title="此接入需要补填最新 Key"
          message="其他设备替换了 Key。请补填最新 Key；机器人仍使用原来的接入。"
        />
      ) : missing ? (
        <Feedback
          title="这台设备还没有完整 Key"
          message="接入信息已同步。补填此接入当前使用的 Key 后，即可在这台设备使用。"
        />
      ) : null}
      {error && !list && retry}
      {list && !list.connections.length && !error && (
        <section className="me-empty">
          <h2>还没有模型接入</h2>
          <p className="secondary">添加你自己的 API Key，之后创建机器人时即可选择对应模型。</p>
          <Button onClick={() => open('add')}>添加接入</Button>
        </section>
      )}
      {Boolean(list?.connections.length) && (
        <>
          <div className="me-key-toolbar">
            <h2 className="me-label">已保存的接入</h2>
            <Button
              variant="text"
              onClick={() => open('sort')}
              disabled={Boolean(error) || loading}
            >
              调整顺序
            </Button>
          </div>
          <ul className="me-key-list">
            {list!.connections.map((c) => {
              const fill = ['missing', 'stale'].includes(c.localCredentialState)
              return (
                <li key={c.id} className="me-key-row">
                  <span className="me-provider-monogram" aria-hidden="true">
                    {c.providerId === 'deepseek' ? 'D' : c.providerId === 'openai' ? 'O' : 'R'}
                  </span>
                  <div className="me-key-identity">
                    <p className="me-label">{c.displayName}</p>
                    <p className="me-caption">
                      {providerLabels[c.providerId]} · {c.keyHint}
                    </p>
                    <p className="me-caption">{connectionStatus(c)}</p>
                  </div>
                  <Button
                    variant="text"
                    className={fill ? 'me-fill-action' : ''}
                    aria-label={`${fill ? '补填 Key' : '管理'} ${c.displayName}`}
                    onClick={() => open(fill ? 'fill' : 'manage', c)}
                    disabled={Boolean(error) || loading}
                  >
                    {fill ? '补填 Key' : '管理'}
                  </Button>
                </li>
              )
            })}
          </ul>
          <p className="me-caption">
            完整 Key 仅保存在本机。换设备需补填；创建机器人时选择模型与接入。
          </p>
          {error && retry}
        </>
      )}
      {dialog && list && (
        <KeyDialog
          key={dialog.connection?.id ?? dialog.mode}
          initialMode={dialog.mode}
          connection={dialog.connection}
          list={list}
          onClose={() => setDialog(null)}
          onRefresh={reload}
          onSuccess={(title, message) => setSuccess({ title, message })}
        />
      )}
    </>
  )
}
