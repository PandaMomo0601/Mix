// Synthetic platform boundary for the real Electron/SDK/IPC test. Provider and
// PostgreSQL logic are verified separately by the shared backend test suite.
// This fixture must never delegate an unknown URL to the network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const base = require('./auth-server.cjs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { randomUUID } = require('node:crypto')
const state = {
  user: structuredClone(base.user),
  connections: [],
  revision: 0,
  operations: {},
  keys: {},
  requests: [],
  offline: false,
  hold: null,
  release: null,
  dropNextCommit: false,
  listError: false,
  deleting: false,
  deletion: null
}
const providers = [
  { id: 'deepseek', label: 'DeepSeek', enabled: true, probe: null },
  {
    id: 'openai',
    label: 'OpenAI',
    enabled: true,
    probe: {
      version: 'fixture-paid-v1',
      model: 'fixture-model',
      paid: true,
      description: '仅用于隔离自测，不发送真实请求。'
    }
  },
  { id: 'openrouter', label: 'OpenRouter', enabled: true, probe: null }
]
async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input))
  if (!url.hostname.endsWith('.supabase.co')) throw Error('Unexpected fixture destination')
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
  const action = body.action || url.pathname.split('/').at(-1)
  state.requests.push({
    action,
    fields: Object.keys(body),
    profileFields: Object.keys(body.data || {}),
    method: init.method || 'GET'
  })
  if (state.offline) throw TypeError('Synthetic offline fixture')
  const headers = { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers })
  const ok = (data) => reply({ ok: true, data })
  const fail = (code) => reply({ ok: false, error: { code } }, code === 'unauthorized' ? 401 : 400)
  if (url.pathname.startsWith('/auth/v1/')) {
    if (action === 'user') {
      if (state.deleting) return reply({ code: 'user_not_found', message: 'fixture' }, 401)
      if (init.method === 'PUT' && body.data) Object.assign(state.user.user_metadata, body.data)
      return reply(state.user)
    }
    if (action === 'token') {
      if (body.password && body.password !== 'FixtureOnly!2026')
        return reply({ code: 'invalid_credentials', message: 'fixture' }, 400)
      return reply({ ...base.session(), user: state.user })
    }
    if (action === 'logout') return new Response(null, { status: 204, headers })
    return base.fakeFetch(input, init)
  }
  if (url.pathname === '/rest/v1/rpc/mix_account_available') return reply(!state.deleting)
  if (url.pathname === '/rest/v1/rpc/mix_account_status')
    return reply(state.deleting ? 'deleting' : 'active')
  if (url.pathname === '/functions/v1/delete-account') {
    if (body.password !== 'FixtureOnly!2026') return fail('reauthentication_failed')
    state.deleting = true
    state.deletion = {
      requestId: body.requestId,
      secret: body.receiptSecret,
      data: { operationId: randomUUID(), phase: 'processing', nextPollAfter: 10 }
    }
    return ok(state.deletion.data)
  }
  if (url.pathname === '/functions/v1/account-deletion-status') {
    if (
      !state.deletion ||
      body.requestId !== state.deletion.requestId ||
      body.receiptSecret !== state.deletion.secret
    )
      return fail('not_found')
    return ok(state.deletion.data)
  }
  if (url.pathname !== '/functions/v1/me-connections') throw Error('Unexpected fixture endpoint')
  if (state.deleting) return fail('unauthorized')
  if (action === 'list')
    return state.listError
      ? fail('provider_unavailable')
      : ok({ connections: state.connections, providers, listRevision: state.revision })
  if (action === 'operation')
    return state.operations[body.requestId]
      ? ok(state.operations[body.requestId])
      : fail('not_found')
  if (state.operations[body.requestId]) return ok(state.operations[body.requestId])
  if (state.hold === action)
    await new Promise((resolve) => {
      state.release = resolve
    })
  const current = state.connections.find((c) => c.id === body.id)
  if (action !== 'create' && action !== 'reorder' && !current) return fail('not_found')
  if (body.expectedRevision && current.revision !== body.expectedRevision) return fail('conflict')
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
  if (key && key.includes('invalid')) return fail('invalid_key')
  if (
    key &&
    ['create', 'replace'].includes(action) &&
    Object.entries(state.keys).some(([id, saved]) => id !== body.id && saved === key)
  )
    return fail('duplicate_key')
  if (action === 'create' && state.connections.length >= 20) return fail('limit_reached')
  let result
  if (action === 'create') {
    const n = state.connections.filter((c) => c.providerId === body.providerId).length
    const label = providers.find((p) => p.id === body.providerId).label
    result = {
      id: randomUUID(),
      providerId: body.providerId,
      displayName: body.displayName || label + (n ? n : ''),
      keyHint: '•••• ' + key.slice(-4),
      status: 'verified',
      lastVerifiedAt: new Date().toISOString(),
      displayOrder: state.connections.length,
      revision: 1,
      credentialVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    state.connections.push(result)
    state.keys[result.id] = key
  } else if (action === 'rename') {
    if (state.connections.some((c) => c.id !== current.id && c.displayName === body.displayName))
      return fail('duplicate_name')
    result = Object.assign(current, {
      displayName: body.displayName,
      revision: current.revision + 1
    })
  } else if (action === 'replace') {
    state.keys[current.id] = key
    result = Object.assign(current, {
      keyHint: '•••• ' + key.slice(-4),
      revision: current.revision + 1,
      credentialVersion: current.credentialVersion + 1
    })
  } else if (action === 'attach') {
    if (state.keys[current.id] !== key) return fail('credential_mismatch')
    result = current
  } else if (action === 'revalidate') {
    if (state.keys[current.id] !== key) return fail('credential_mismatch')
    result = Object.assign(current, {
      lastVerifiedAt: new Date().toISOString(),
      status: 'verified',
      revision: current.revision + 1
    })
  } else if (action === 'delete') {
    state.connections = state.connections.filter((c) => c.id !== current.id)
    delete state.keys[current.id]
    result = {}
  } else if (action === 'reorder') {
    state.connections = body.ids.map((id, displayOrder) =>
      Object.assign(
        state.connections.find((c) => c.id === id),
        { displayOrder }
      )
    )
    result = {}
  } else if (action === 'models') return ok([{ id: 'fixture/v4flash', label: 'V4 Flash' }])
  else throw Error('Unexpected fixture action')
  state.revision++
  state.operations[body.requestId] = structuredClone(result)
  if (state.dropNextCommit) {
    state.dropNextCommit = false
    throw TypeError('Synthetic response lost after commit')
  }
  return ok(result)
}
module.exports = { state, fakeFetch }
