// Only used by the isolated QA runner. These responses never contact Supabase.
// Loaded synchronously by the packaged CommonJS main process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const base = require('./auth-server.cjs')
const state = {
  offline: false,
  badCredentials: false,
  unconfirmed: false,
  rateLimit: false,
  hold: null,
  release: null,
  metadata: base.user.user_metadata,
  requests: []
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input))
  if (!url.pathname.startsWith('/auth/v1/')) throw Error('Unexpected QA network destination')
  const operation = url.pathname.split('/').at(-1)
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
  state.requests.push({
    operation,
    method: init.method || 'GET',
    scope: url.searchParams.get('scope'),
    passwordUnchanged: body.password === ' a ',
    passwordLength: typeof body.password === 'string' ? body.password.length : null
  })
  if (state.hold === operation)
    await new Promise((resolve) => {
      state.release = resolve
    })
  if (state.offline) throw new TypeError('Synthetic QA offline response')
  const headers = { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers })
  if (state.rateLimit)
    return reply(
      { code: 'over_request_rate_limit', message: 'Private backend fixture detail' },
      429
    )
  if (operation === 'token') {
    if (state.badCredentials)
      return reply({ code: 'invalid_credentials', message: 'Private backend fixture detail' }, 400)
    if (state.unconfirmed)
      return reply({ code: 'email_not_confirmed', message: 'Private backend fixture detail' }, 400)
    return reply({ ...base.session(), user: { ...base.user, user_metadata: state.metadata } })
  }
  if (operation === 'user') return reply({ ...base.user, user_metadata: state.metadata })
  if (operation === 'signup')
    return reply({ ...base.user, email_confirmed_at: null, user_metadata: state.metadata })
  if (operation === 'logout') return new Response(null, { status: 204, headers })
  if (operation === 'recover' || operation === 'resend') return reply({})
  throw Error('Unexpected QA Auth endpoint')
}

module.exports = { state, fakeFetch }
