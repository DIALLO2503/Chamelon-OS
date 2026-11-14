// The access token lives in memory only; the refresh token is an httpOnly cookie the browser sends to /api/auth/refresh.
let accessToken = null
let onExpired = () => {}
let refreshing = null

export const session = {
  get active() { return Boolean(accessToken) },
  set(token) { accessToken = token },
  onExpired(fn) { onExpired = fn },
  async restore() {
    try { accessToken = (await request('/auth/refresh', { body: {}, retry: false })).accessToken; return true } catch { return false }
  },
  async logout() { await request('/auth/logout', { body: {}, retry: false }).catch(() => {}); accessToken = null },
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
  } catch { throw new Error('Pas de connexion. Vérifiez le réseau et réessayez.') }
  if (res.status === 401 && retry && accessToken && !path.startsWith('/auth/')) {
    refreshing ??= session.restore().finally(() => { refreshing = null })
    if (await refreshing) return request(path, { body, idem, retry: false, raw, query })
    accessToken = null
    onExpired()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || 'Une erreur est survenue'), { status: res.status })
  return data
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
