import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ConnectionList,
  ConnectionSummary,
  ProviderId,
  MeResult,
  ConnectionWriteResult,
  MeFailure
} from '../../../../shared/me'
import { normalizeKey, normalizeName } from '../../../../shared/me-validation'
import { Button, Field, Feedback } from '../auth/Controls'
import { Dialog } from './Dialog'
import { providerLabels, meCall, type KeyMode } from './me-ui'

export function KeyDialog({
  initialMode,
  connection,
  list,
  onClose,
  onRefresh,
  onSuccess
}: {
  initialMode: KeyMode
  connection?: ConnectionSummary
  list: ConnectionList
  onClose: () => void
  onRefresh: () => Promise<ConnectionList | null>
  onSuccess: (title: string, message: string) => void
}): React.JSX.Element {
  const [mode, setMode] = useState(initialMode)
  const [current, setCurrent] = useState(connection)
  const [cleanupFailed, setCleanupFailed] = useState(false)
  const [provider, setProvider] = useState<ProviderId>(
    connection?.providerId ?? list.providers.find((p) => p.enabled)?.id ?? 'deepseek'
  )
  const suggest = (id: ProviderId): string => {
    const base = providerLabels[id]
    const names = new Set(list.connections.map((c) => c.displayName))
    let n = 0
    while (names.has(base + (n || ''))) n++
    return base + (n || '')
  }
  const [name, setName] = useState(connection?.displayName ?? suggest(provider))
  const [nameEdited, setNameEdited] = useState(false)
  const [choosingProvider, setChoosingProvider] = useState(false)
  const [confirmingProbe, setConfirmingProbe] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const providerControl = useRef<HTMLButtonElement>(null)
  const [key, setKey] = useState('')
  const [order, setOrder] = useState(list.connections.map((c) => c.id))
  const [phase, setPhase] = useState<'editing' | 'pending' | 'result' | 'partial' | 'unknown'>(
    'editing'
  )
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState<MeFailure | null>(null)
  const [fieldError, setFieldError] = useState('')
  const [nameError, setNameError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [operation, setOperation] = useState<string | null>(null)
  const alive = useRef(true),
    resultRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (['result', 'partial', 'unknown'].includes(phase)) resultRef.current?.focus()
  }, [phase])
  useEffect(() => {
    if (!retryAt) return
    const timer = setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()))
    return () => clearTimeout(timer)
  }, [retryAt])
  const retryWaiting = retryAt > 0
  const providerConfig = list.providers.find((p) => p.id === provider)
  const needsKey = ['add', 'replace', 'fill'].includes(mode)
  const validates = needsKey || mode === 'revalidate'
  const c = current
  const title = choosingProvider
    ? '选择服务商'
    : confirmingProbe
      ? '需要调用模型验证'
      : recovering
        ? '恢复本机保存'
        : recovered
          ? '补填本机 Key'
          : phase === 'partial'
            ? '接入尚未完成保存'
            : failure?.code === 'limit_reached'
              ? 'API Key 数量已达上限'
              : failure?.code === 'local_key_locked'
                ? '无法安全保存 Key'
                : mode === 'fill' && phase === 'pending'
                  ? '验证并保存到本机'
                  : mode === 'add'
                    ? '添加接入'
                    : mode === 'manage'
                      ? '管理接入'
                      : mode === 'rename'
                        ? '修改接入名称'
                        : mode === 'replace'
                          ? '替换 API Key'
                          : mode === 'fill'
                            ? '补填本机 Key'
                            : mode === 'revalidate'
                              ? '重新验证'
                              : mode === 'delete'
                                ? '删除这个接入？'
                                : '调整展示顺序'
  function changeMode(next: KeyMode): void {
    setMode(next)
    setPhase('editing')
    setFailure(null)
    setMessage('')
    setFieldError('')
    setNameError('')
    setRetryAt(0)
    setKey('')
    setConfirmingProbe(false)
    setChoosingProvider(false)
    setRecovered(false)
    setOperation(null)
  }
  function showError(error: MeFailure, targetMode = mode): void {
    setFailure(error)
    if (error.code === 'rate_limited')
      setRetryAt(Date.now() + Math.max(1, Math.min(error.retryAfter ?? 60, 3600)) * 1000)
    setMessage(error.message)
    setPhase(
      ['unknown', 'probe_unknown'].includes(error.code)
        ? 'unknown'
        : targetMode === 'revalidate'
          ? 'result'
          : 'editing'
    )
  }
  async function submit(targetMode: KeyMode = mode, paidConsent = false): Promise<void> {
    if (retryWaiting) return
    setFieldError('')
    setNameError('')
    setFailure(null)
    if (['add', 'replace', 'fill'].includes(targetMode))
      try {
        normalizeKey(key)
      } catch {
        setFieldError(key.trim() ? 'API Key 不能包含内部空格或换行。' : '请输入 API Key。')
        return
      }
    if (targetMode === 'rename' || targetMode === 'manage' || targetMode === 'add')
      try {
        normalizeName(name)
      } catch {
        setNameError('接入名称需要1—40个字符，不能包含换行。')
        return
      }
    if (
      ['add', 'replace', 'fill', 'revalidate'].includes(targetMode) &&
      providerConfig?.probe?.paid &&
      !paidConsent
    ) {
      setConfirmingProbe(true)
      return
    }
    setConfirmingProbe(false)
    setRecovered(false)
    const requestId = crypto.randomUUID()
    setOperation(requestId)
    setPhase('pending')
    const base = c ? { id: c.id, expectedRevision: c.revision, requestId } : null
    const confirmedProbeVersion = paidConsent ? providerConfig?.probe?.version : undefined
    let result: MeResult<
      ConnectionWriteResult | { localCleanup: 'done' | 'failed' } | ConnectionList
    >
    try {
      if (targetMode === 'add')
        result = await window.mix.me.createVerifiedConnection({
          providerId: provider,
          apiKey: key,
          requestId,
          ...(nameEdited ? { displayName: name } : {}),
          confirmedProbeVersion
        })
      else if (targetMode === 'rename' || targetMode === 'manage')
        result = await window.mix.me.updateConnection({ ...base!, displayName: name })
      else if (targetMode === 'replace')
        result = await window.mix.me.updateConnection({
          ...base!,
          apiKey: key,
          confirmedProbeVersion
        })
      else if (targetMode === 'fill')
        result = await window.mix.me.attachLocalCredential({
          ...base!,
          credentialVersion: c!.credentialVersion,
          apiKey: key,
          confirmedProbeVersion
        })
      else if (targetMode === 'revalidate')
        result = await window.mix.me.revalidateConnection({
          ...base!,
          credentialVersion: c!.credentialVersion,
          confirmedProbeVersion
        })
      else if (targetMode === 'delete') result = await window.mix.me.deleteConnection(base!)
      else
        result = await window.mix.me.reorderConnections({
          ids: order,
          listRevision: list.listRevision,
          requestId
        })
    } catch {
      result = { ok: false, error: { code: 'unknown', message: '尚未确认操作结果，请先核对。' } }
    }
    if (!alive.current) return
    void onRefresh()
    if (!result.ok) {
      showError(result.error, targetMode)
      return
    }
    setKey('')
    if ('connection' in result.data) setCurrent(result.data.connection)
    if ('localCleanup' in result.data) setCleanupFailed(result.data.localCleanup === 'failed')
    if ('outcome' in result.data && result.data.outcome === 'partial') {
      setPhase('partial')
      setMessage('云端接入已保存，本机 Key 保存未完成。请恢复本机保存，或在原接入补填。')
      return
    }
    if (
      !['fill', 'revalidate'].includes(targetMode) &&
      !('localCleanup' in result.data && result.data.localCleanup === 'failed')
    ) {
      const feedback =
        targetMode === 'add'
          ? ['接入已保存', '现在可以在创建机器人时选择这个接入带来的模型。']
          : targetMode === 'replace'
            ? ['API Key 已替换', '已关联的机器人继续使用这个接入。']
            : targetMode === 'delete'
              ? ['接入已删除', '使用该接入的机器人需要重新选择模型接入。']
              : targetMode === 'sort'
                ? ['展示顺序已更新', '模型调用仍按机器人选择的接入进行。']
                : ['名称已更新', '已关联的机器人继续使用同一个接入。']
      onSuccess(feedback[0], feedback[1])
      onClose()
      return
    }
    setPhase('result')
    setMessage(
      targetMode === 'revalidate'
        ? 'API Key 当前可用。\n最近验证：刚刚。'
        : mode === 'replace'
          ? 'Key 已替换，机器人绑定保持不变。其他设备需要补填最新 Key。'
          : mode === 'fill'
            ? '这台设备现在可以使用此接入。没有新增接入，也没有改变机器人绑定。'
            : mode === 'delete'
              ? 'localCleanup' in result.data && result.data.localCleanup === 'failed'
                ? '接入已删除，本机清理未完成。请重试清理。'
                : '接入已删除。引用它的机器人需要重新选择模型接入。'
              : mode === 'sort'
                ? '展示顺序已更新。'
                : '保存成功。'
    )
  }
  async function recover(): Promise<void> {
    if (!operation) return
    setRecovering(true)
    setPhase('pending')
    const result = await meCall(window.mix.me.recoverOperation({ requestId: operation }))
    if (!alive.current) return
    setRecovering(false)
    if (result.ok) {
      setFailure(null)
      setKey('')
      setPhase('result')
      setRecovered(true)
      setCurrent(result.data.connection)
      if (needsKey && result.data.connection.localCredentialState !== 'ready') {
        setPhase('partial')
        setMessage('云端修改已确认，请在原接入补填本机 Key。')
      } else setMessage(needsKey ? '本机保存已恢复。' : '已核对，操作已经完成。')
      void onRefresh()
    } else {
      showError(result.error)
      if (['local_key_locked', 'local_storage_error'].includes(result.error.code))
        setPhase('partial')
    }
  }
  async function retryCleanup(): Promise<void> {
    if (!c || !operation) return
    setPhase('pending')
    const result = await meCall(
      window.mix.me.deleteConnection({
        id: c.id,
        expectedRevision: c.revision,
        requestId: operation
      })
    )
    if (!alive.current) return
    setPhase('result')
    if (result.ok) {
      setCleanupFailed(result.data.localCleanup === 'failed')
      setMessage(
        result.data.localCleanup === 'done' ? '本机清理已完成。' : '本机清理仍未完成，请重试。'
      )
    } else showError(result.error)
  }
  function move(id: string, direction: number): void {
    setOrder((ids) => {
      const next = [...ids],
        at = next.indexOf(id),
        to = at + direction
      if (to < 0 || to >= next.length) return ids
      ;[next[at], next[to]] = [next[to], next[at]]
      return next
    })
  }
  const canFill = c && ['missing', 'stale'].includes(c.localCredentialState)
  const pending = phase === 'pending'
  const localLocked = failure?.code === 'local_key_locked'
  const limit = failure?.code === 'limit_reached'
  const profileDialog =
    !confirmingProbe &&
    !choosingProvider &&
    (mode === 'fill' || phase === 'partial' || localLocked || recovering || recovered)
  const transient = Boolean(
    failure && ['provider_unavailable', 'validation_timeout', 'rate_limited'].includes(failure.code)
  )
  const permission = Boolean(
    failure && ['permission_denied', 'quota_unavailable'].includes(failure.code)
  )
  const recheckInvalid = mode === 'revalidate' && failure?.code === 'invalid_key'
  const storageCopy =
    '完整 Key 仅保存在本机；验证时经 Mix 服务器临时转发给服务商，服务器不保存完整 Key。'
  const fillCopy = '这台设备现在可以使用此接入。没有新增接入，也没有改变机器人绑定。'
  const closeChoice = (): void => {
    setChoosingProvider(false)
    requestAnimationFrame(() => providerControl.current?.focus())
  }
  const cancelProbe = (): void => {
    setConfirmingProbe(false)
    if (mode === 'revalidate') changeMode('manage')
  }
  const close = choosingProvider ? closeChoice : confirmingProbe ? cancelProbe : onClose
  const startRecheck = (): void => {
    changeMode('revalidate')
    void submit('revalidate')
  }
  const refreshConnection = async (): Promise<void> => {
    const next = await onRefresh()
    const updated = next?.connections.find((v) => v.id === c?.id)
    if (updated) {
      setCurrent(updated)
      setFailure(null)
      setMessage('')
    }
  }
  const ordinaryError = (): ReactNode => {
    if (!failure) return null
    let heading = '操作未完成',
      body = failure.message
    if (mode === 'add') {
      const copy = {
        duplicate_key: ['这个 API Key 已添加', '不能重复添加同一个 Key，请更换后再试。'],
        invalid_key: ['API Key 无效或已失效', '服务商鉴权未通过，请检查 Key 后重试。'],
        duplicate_name: ['接入名称已存在', '请换一个名字，方便区分不同接入。'],
        permission_denied: [
          '此接入暂不可用',
          '此接入暂不具备所需权限或可用额度，请前往服务商处理后重试。'
        ],
        quota_unavailable: [
          '此接入暂不可用',
          '此接入暂不具备所需权限或可用额度，请前往服务商处理后重试。'
        ],
        provider_unavailable: ['暂时无法验证', '请检查网络或稍后重试。这不代表 Key 错误。'],
        validation_timeout: ['暂时无法验证', '请检查网络或稍后重试。这不代表 Key 错误。'],
        rate_limited: ['操作过于频繁', `请在 ${failure.retryAfter ?? 60} 秒后重试。`]
      }[failure.code as 'invalid_key']
      if (copy) [heading, body] = copy
    } else if (mode === 'manage' || mode === 'rename') {
      if (failure.code === 'conflict')
        [heading, body] = ['这条接入已更新', '请刷新后重试，避免覆盖其他设备的修改。']
      else if (failure.code === 'duplicate_name')
        [heading, body] = ['接入名称已存在', '请换一个名字，方便区分不同接入。']
    } else if (mode === 'replace')
      [heading, body] = [
        '替换未完成',
        failure.code === 'invalid_key'
          ? '新 Key 未通过验证，原来的 Key 仍然保留。'
          : failure.message
      ]
    else if (mode === 'fill')
      [heading, body] =
        failure.code === 'credential_mismatch'
          ? [
              '与此接入当前的 Key 不匹配',
              '请确认填写的是当前 Key。要更换另一把 Key，请使用“替换 API Key”。'
            ]
          : [
              '暂时无法验证',
              transient
                ? '网络或服务暂时不可用，尚未保存到本机。当前输入已保留，请稍后重试。'
                : failure.message
            ]
    else if (mode === 'delete') [heading, body] = ['删除未完成', '接入仍然保留，请检查网络后重试。']
    else if (mode === 'sort') [heading, body] = ['顺序未保存', '请重试，原来的顺序仍然保留。']
    return <Feedback title={heading} message={body} error />
  }
  const nameField = (
    <Field
      name="me-connection-name"
      label="接入名称"
      value={name}
      disabled={pending}
      onChange={(event) => {
        setName(event.target.value)
        setNameEdited(true)
        setNameError('')
        if (failure?.code === 'duplicate_name') setFailure(null)
      }}
      error={
        nameError
          ? nameError
          : failure?.code === 'duplicate_name'
            ? '这个名称已使用，请更换。'
            : undefined
      }
      hint={
        mode === 'manage' ? '修改名称不会改变机器人使用的接入。' : '用于选择模型时区分不同接入。'
      }
    />
  )
  const keyField = (
    <Field
      name="me-key"
      label={mode === 'replace' ? '新的 API Key' : 'API Key'}
      type="password"
      passwordToggle={mode !== 'fill'}
      value={key}
      disabled={pending}
      onChange={(event) => {
        setKey(event.target.value)
        setFieldError('')
      }}
      autoComplete="off"
      spellCheck={false}
      placeholder={
        mode === 'replace'
          ? '请输入新的 API Key'
          : mode === 'fill'
            ? '请输入此接入当前的 Key'
            : '请输入 API Key'
      }
      error={fieldError}
      invalid={['duplicate_key', 'invalid_key', 'credential_mismatch'].includes(
        failure?.code ?? ''
      )}
      hint={
        mode === 'replace'
          ? '新 Key 在本机安全保存；其他设备的旧 Key 将过期。'
          : mode === 'fill'
            ? failure?.code === 'credential_mismatch'
              ? '请填写与此接入对应的当前 Key。'
              : '已保存的完整 Key 不会再次显示。'
            : '验证通过后加密保存在本机，完整 Key 不会再次显示。'
      }
    />
  )
  let body: ReactNode
  let footer: ReactNode
  let height = 400
  const cancel = (
    <Button variant="secondary" onClick={onClose} disabled={pending}>
      取消
    </Button>
  )
  if (choosingProvider) {
    height = 354
    body = (
      <>
        <p>选择你的 API Key 所属的服务商。</p>
        <div className="me-provider-choices">
          {(['openai', 'deepseek', 'openrouter'] as const).map((id) => (
            <Button
              key={id}
              variant="secondary"
              disabled={!list.providers.find((v) => v.id === id)?.enabled}
              onClick={() => {
                setProvider(id)
                if (!nameEdited) setName(suggest(id))
                closeChoice()
              }}
            >
              {providerLabels[id]}
            </Button>
          ))}
        </div>
      </>
    )
    footer = (
      <Button variant="secondary" onClick={closeChoice}>
        取消
      </Button>
    )
  } else if (confirmingProbe) {
    height = 296
    body = (
      <>
        <p>这个服务商需要发送一次测试请求，才能确认 Key 是否可调用。</p>
        <Feedback
          title="可能产生服务商费用"
          message="请求使用你填写的 API Key，费用由服务商按其规则收取。你可以取消本次添加。"
        />
      </>
    )
    footer = (
      <>
        <Button variant="secondary" onClick={cancelProbe}>
          取消
        </Button>
        <Button onClick={() => void submit(mode, true)}>同意并验证</Button>
      </>
    )
  } else if (limit) {
    height = 208
    body = (
      <>
        <p>请先删除不再使用的接入后重试。</p>
        <p className="me-caption">你仍可查看、改名、替换和删除已有接入。</p>
      </>
    )
    footer = (
      <>
        {cancel}
        <Button onClick={onClose}>管理已有接入</Button>
      </>
    )
  } else if (localLocked) {
    height = 500
    body = (
      <>
        <Feedback
          title="本机安全存储暂不可用"
          message="尚未发送本次 Key，也没有创建接入。请解锁系统钥匙串或恢复安全存储后重试。"
          error
        />
        <p className="me-caption">输入仅暂留本次表单；关闭表单后需要重新填写。</p>
      </>
    )
    footer = (
      <>
        {cancel}
        <Button onClick={() => void submit()}>重新检查</Button>
      </>
    )
  } else if (phase === 'partial') {
    height = 500
    body = (
      <>
        <Feedback
          title="接入信息已保存，本机 Key 尚未保存"
          message="请继续完成本机保存。无需重新添加接入；其他设备需要自行补填 Key。"
        />
        <p>关闭后可在原接入中补填，不会重复占用名额。</p>
      </>
    )
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          稍后补填
        </Button>
        <Button onClick={() => void recover()}>重试本机保存</Button>
      </>
    )
  } else if (recovering || recovered) {
    height = 360
    body = (
      <Feedback
        title={recovering ? '正在恢复本机保存' : '本机保存已恢复'}
        message={recovering ? '使用已保存的接入继续处理，不会重复创建。' : fillCopy}
      />
    )
    footer = (
      <Button disabled={recovering} onClick={onClose}>
        {recovering ? '恢复中…' : '完成'}
      </Button>
    )
  } else if (phase === 'unknown') {
    height = profileDialog ? 500 : 400
    body = (
      <div ref={resultRef} tabIndex={-1}>
        <Feedback title="结果待核对" message={message} error />
      </div>
    )
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          稍后核对
        </Button>
        {operation && !['delete', 'sort'].includes(mode) && (
          <Button onClick={() => void recover()}>核对操作结果</Button>
        )}
        {['delete', 'sort'].includes(mode) && (
          <Button
            onClick={() => {
              void onRefresh()
              onClose()
            }}
          >
            核对最新列表
          </Button>
        )}
      </>
    )
  } else if (mode === 'revalidate') {
    height = pending ? 314 : recheckInvalid ? 374 : permission ? 396 : failure ? 314 : 336
    const copy = pending
      ? [
          '正在验证…',
          '正在检查该接入的服务商鉴权与可用性。请稍候。',
          '只检查这个接入，不会替换 Key 或切换机器人使用的来源。'
        ]
      : recheckInvalid
        ? [
            '验证未通过',
            'API Key 无效或已失效，服务商鉴权未通过。请检查或替换后再试。',
            '接入记录和机器人关联仍保留；不会自动改用其他接入。'
          ]
        : permission
          ? [
              '此接入暂不可用',
              '服务商返回权限或额度不足。请到服务商处理后重新验证，或替换 Key。',
              '原接入与机器人关联仍保留，不会自动切换到其他来源。'
            ]
          : failure
            ? [
                '暂时无法验证',
                transient
                  ? '网络连接超时或服务商暂不可用。请稍后重试，这不代表 Key 无效。'
                  : failure.message,
                '保留上次验证状态和原来的 Key，本次没有替换或删除接入。'
              ]
            : ['验证通过', message, '这是本次验证结果，后续可用性以服务商实际响应为准。']
    body = (
      <>
        <p className="me-dialog-title-text">{c!.displayName}</p>
        <Feedback title={copy[0]} message={copy[1]} error={Boolean(failure)} />
        <p className="me-caption">{copy[2]}</p>
        {recheckInvalid && (
          <Button className="me-body-action" variant="secondary" onClick={() => void submit()}>
            重新验证
          </Button>
        )}
        {permission && (
          <Button
            className="me-body-action"
            variant="secondary"
            onClick={() => changeMode('replace')}
          >
            替换 API Key
          </Button>
        )}
      </>
    )
    footer = pending ? (
      <Button disabled>验证中…</Button>
    ) : (
      <>
        <Button
          variant="secondary"
          className="me-recheck-return"
          onClick={() =>
            window.matchMedia('(max-width: 679px)').matches && !failure
              ? onClose()
              : changeMode('manage')
          }
        >
          <span className="me-wide-label">返回管理</span>
          <span className="me-small-label">{failure ? '返回管理' : '返回列表'}</span>
        </Button>
        <Button
          onClick={
            recheckInvalid ? () => changeMode('replace') : failure ? () => void submit() : onClose
          }
        >
          {recheckInvalid ? '替换 API Key' : permission ? '重新验证' : failure ? '重试' : '完成'}
        </Button>
      </>
    )
  } else if (mode === 'fill' && (pending || phase === 'result')) {
    height = 360
    body = (
      <Feedback
        title={pending ? '正在验证 Key 并保存到本机' : '本机 Key 已保存'}
        message={pending ? '验证与当前接入匹配后，加密保存在这台设备。' : fillCopy}
      />
    )
    footer = (
      <Button disabled={pending} onClick={onClose}>
        {pending ? '验证中…' : '完成'}
      </Button>
    )
  } else if (cleanupFailed) {
    height = 352
    body = <Feedback title="本机清理尚未完成" message={message} error />
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          稍后清理
        </Button>
        <Button onClick={() => void retryCleanup()} disabled={pending}>
          重试本机清理
        </Button>
      </>
    )
  } else {
    height =
      mode === 'add'
        ? failure
          ? 548
          : 490
        : mode === 'manage' || mode === 'rename'
          ? 580
          : mode === 'replace'
            ? failure
              ? 424
              : 324
            : mode === 'fill'
              ? 500
              : mode === 'delete'
                ? failure
                  ? 352
                  : 252
                : 354 + Math.max(0, order.length - 3) * 60 + (failure ? 100 : 0)
    if (mode === 'manage' || mode === 'rename')
      body = (
        <>
          {ordinaryError()}
          {nameField}
          <Field
            name="me-saved-provider"
            label="服务商"
            value={providerLabels[c!.providerId]}
            readOnly
            disabled
          />
          <Field
            name="me-saved-key"
            label="已保存的 API Key"
            value={c!.keyHint}
            readOnly
            disabled
            hint="完整 Key 不会再次显示。"
          />
          <div className="me-management-actions">
            <Button variant="secondary" disabled={pending} onClick={() => changeMode('replace')}>
              替换 API Key
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={canFill ? () => changeMode('fill') : startRecheck}
            >
              {canFill ? '补填本机 Key' : '重新验证'}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => changeMode('delete')}>
              删除接入
            </Button>
          </div>
          {failure?.code === 'conflict' && (
            <Button
              variant="secondary"
              className="me-body-action"
              onClick={() => void refreshConnection()}
            >
              刷新接入
            </Button>
          )}
        </>
      )
    else if (mode === 'add')
      body = (
        <>
          {failure ? (
            ordinaryError()
          ) : (
            <p className="secondary">接入后，创建机器人时选择对应模型即可。</p>
          )}
          <div className="me-provider-field">
            <span id="me-provider-label">服务商</span>
            <button
              type="button"
              ref={providerControl}
              className="me-provider-control"
              aria-labelledby="me-provider-label"
              aria-haspopup="dialog"
              disabled={pending}
              onClick={() => setChoosingProvider(true)}
            >
              <span>{providerLabels[provider]}</span>
              <span>选择</span>
            </button>
          </div>
          {nameField}
          {keyField}
          {!failure && !pending && !fieldError && <p className="me-caption">{storageCopy}</p>}
        </>
      )
    else if (mode === 'replace' || mode === 'fill')
      body = (
        <>
          <p className={mode === 'fill' ? 'me-dialog-title-text' : 'me-label'}>{c!.displayName}</p>
          <p className="secondary">
            {mode === 'replace'
              ? '验证通过后替换，机器人继续使用此接入。其他设备需要补填最新 Key。'
              : '补填当前接入的 Key，不新增接入。'}
          </p>
          {ordinaryError()}
          {keyField}
          {mode === 'fill' ? (
            <p className="me-caption">
              完整 Key 仅保存在这台设备。验证时经 Mix 服务器临时转发给服务商，服务器不保存完整 Key。
            </p>
          ) : (
            !failure && !pending && <p className="me-caption">{storageCopy}</p>
          )}
          {failure?.code === 'credential_mismatch' && (
            <Button
              variant="secondary"
              className="me-body-action"
              onClick={() => changeMode('replace')}
            >
              替换 API Key
            </Button>
          )}
        </>
      )
    else if (mode === 'delete')
      body = (
        <>
          <p className="me-dialog-title-text">{c!.displayName}</p>
          <p>删除后，使用此接入的机器人需要重新选择模型接入。机器人本身会保留。</p>
          <p className="me-caption">这只会移除 Mix 保存的接入与凭据，不会撤销服务商的 Key。</p>
          {ordinaryError()}
        </>
      )
    else
      body = (
        <>
          <p>排序只改变列表的显示顺序，不影响机器人选择的接入，也不会自动轮换。</p>
          {ordinaryError()}
          <ul className="me-sort-list">
            {order.map((id, index) => (
              <li key={id}>
                <span>{list.connections.find((v) => v.id === id)!.displayName}</span>
                <Button
                  variant="text"
                  aria-label={`上移 ${index + 1}`}
                  onClick={() => move(id, -1)}
                  disabled={pending || !index}
                >
                  上移
                </Button>
                <Button
                  variant="text"
                  aria-label={`下移 ${index + 1}`}
                  onClick={() => move(id, 1)}
                  disabled={pending || index === order.length - 1}
                >
                  下移
                </Button>
              </li>
            ))}
          </ul>
        </>
      )
    footer = (
      <>
        {cancel}
        <Button
          disabled={
            pending ||
            retryWaiting ||
            (['replace', 'fill'].includes(mode) && !key.trim()) ||
            (validates && !providerConfig?.enabled)
          }
          onClick={() => void submit()}
        >
          {pending
            ? validates
              ? '正在验证…'
              : '正在保存…'
            : mode === 'delete'
              ? '删除接入'
              : mode === 'manage' || mode === 'rename'
                ? '保存名称'
                : mode === 'sort'
                  ? '保存顺序'
                  : mode === 'replace'
                    ? '验证并替换'
                    : mode === 'fill'
                      ? transient
                        ? '重试验证'
                        : '验证并保存到本机'
                      : '验证并保存'}
        </Button>
      </>
    )
  }
  return (
    <Dialog
      title={title}
      height={height}
      onClose={close}
      busy={pending}
      variant={profileDialog ? 'profile' : 'classic'}
      className={`${mode === 'fill' && !pending && phase !== 'result' ? 'me-dialog-fill' : ''} ${phase === 'partial' ? 'me-dialog-partial' : ''} ${mode === 'revalidate' ? 'me-dialog-recheck' : ''}`}
      footer={footer}
    >
      {body}
    </Dialog>
  )
}
