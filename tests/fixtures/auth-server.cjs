// Synthetic HTTP responses for the real SDK. Never contacts a real Auth service.
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'demo@example.com',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { nickname: '示例用户', avatar: { emoji: '🐼', bg: '#E3F2FD' } },
  is_anonymous: false
}
function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.Zml4dHVyZQ`
}
function session() {
  return {
    access_token: token(),
    refresh_token: 'fixture-refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user
  }
}
const state = { offline: false, badCredentials: false, requests: [] }
async function fakeFetch(input) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input))
  state.requests.push({ path: url.pathname, scope: url.searchParams.get('scope') })
  if (state.offline) throw new TypeError('Synthetic offline response')
  const headers = { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers })
  if (url.pathname.endsWith('/token'))
    return state.badCredentials
      ? reply({ code: 'invalid_credentials', message: 'Invalid fixture credentials' }, 400)
      : reply(session())
  if (url.pathname.endsWith('/user')) return reply(user)
  if (url.pathname === '/rest/v1/rpc/mix_account_available') return reply(true)
  if (url.pathname === '/rest/v1/rpc/mix_account_status') return reply('active')
  if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204, headers })
  if (url.pathname.endsWith('/signup')) return reply(user)
  if (url.pathname.endsWith('/resend') || url.pathname.endsWith('/recover')) return reply({})
  throw Error('Unexpected synthetic Auth endpoint')
}
module.exports = { user, token, session, state, fakeFetch }
