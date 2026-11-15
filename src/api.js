// The access token lives in memory only; the refresh token is an httpOnly cookie the browser sends to /api/auth/refresh.
let accessToken = null
let onExpired = () => {}
let refreshing = null

// Read-only offline view: the last screens seen (profile, home, modules) are kept on this device, so a shopkeeper or an
// artisan with no signal can still read their balances and records. Never used for an action; cleared at sign-out.
const CACHE = 'nexus-cache:'
const CACHED = /^\/(me|home|modules\/[a-z]+)$/
const cacheGet = path => { try { return JSON.parse(localStorage.getItem(CACHE + path)) } catch { return null } }
const cachePut = (path, data) => { try { localStorage.setItem(CACHE + path, JSON.stringify({ at: Date.now(), data })) } catch {} }
export const clearCache = () => { try { Object.keys(localStorage).filter(k => k.startsWith(CACHE)).forEach(k => localStorage.removeItem(k)) } catch {} }
const offlineError = () => Object.assign(new Error('Pas de connexion. Vérifiez le réseau et réessayez.'), { offline: true })

export const session = {
  get active() { return Boolean(accessToken) },
  set(token) { accessToken = token },
  onExpired(fn) { onExpired = fn },
  async restore() {
    try { accessToken = (await request('/auth/refresh', { body: {}, retry: false })).accessToken; return true }
    // No network but a profile seen before on this device: open read-only from the cache.
    catch (e) { return Boolean(e.offline && cacheGet('/me')) }
  },
  async logout() { await request('/auth/logout', { body: {}, retry: false }).catch(() => {}); accessToken = null; clearCache() },
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

async function request(path, { body, idem, retry = true, raw, query } = {}) {
  const url = `/api${path}${query ? `?${new URLSearchParams(query)}` : ''}`
  const headers = raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : { 'Content-Type': 'application/json' }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  if (body !== undefined || raw) headers['Idempotency-Key'] = idem ?? newKey()
  let res
  try {
    res = await fetch(url, { method: body !== undefined || raw ? 'POST' : 'GET', headers, credentials: 'same-origin', body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) })
  } catch {
    const hit = body === undefined && !raw && CACHED.test(path) ? cacheGet(path) : null
    if (hit) return { ...hit.data, _offline: hit.at }
    throw offlineError()
  }
  if (res.status === 401 && retry && accessToken && !path.startsWith('/auth/')) {
    refreshing ??= session.restore().finally(() => { refreshing = null })
    if (await refreshing) return request(path, { body, idem, retry: false, raw, query })
    accessToken = null
    onExpired()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || 'Une erreur est survenue'), { status: res.status })
  if (body === undefined && !raw && CACHED.test(path)) cachePut(path, data)
  return data
}

// Fetches a file from the API (which needs the bearer token, so a plain link cannot) and hands it to the browser to save.
export async function download(path, fallbackName) {
  const res = await fetch(`/api${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'same-origin' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Téléchargement impossible')
  const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// api('/path') → GET; api('/path', { body }) → POST with an idempotency key (pass idem to reuse one across retries).
export const api = (path, opts) => request(path, opts)

// Uploads a photo (raw image body). Optional position is sent as data, never kept inside the file.
export async function uploadImage(file, { publicToken } = {}) {
  let pos = {}
  try {
    pos = await new Promise(resolve => navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve({}), { timeout: 4000, maximumAge: 60000 })
      : resolve({}))
  } catch { pos = {} }
  const path = publicToken ? `/public/${publicToken}/upload` : '/uploads'
  return request(path, { raw: file, query: pos.lat !== undefined ? { lat: pos.lat, lng: pos.lng } : undefined })
}

// Loads a protected image as an object URL (img tags cannot send the Authorization header).
export async function imageUrl(id, { publicToken } = {}) {
  const res = await fetch(publicToken ? `/api/public/${publicToken}/uploads/${id}` : `/api/uploads/${id}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} })
  if (!res.ok) throw new Error('Image indisponible')
  return URL.createObjectURL(await res.blob())
}
