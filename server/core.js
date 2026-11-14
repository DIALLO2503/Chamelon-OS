import { randomUUID, createHash } from 'node:crypto'
import { CURRENCIES, FX_E8_PER_EUR } from './catalog.js'

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export const fail = (message, status = 400) => { throw new AppError(status, message) }
export const newId = () => randomUUID()
export const sha256 = s => createHash('sha256').update(s).digest('hex')
export const today = () => new Date().toISOString().slice(0, 10)

export function normalizePhone(raw, dialCode = '') {
  let s = String(raw ?? '').replace(/[\s.\-()]/g, '')
  if (s.startsWith('00')) s = '+' + s.slice(2)
  if (!s.startsWith('+')) s = dialCode + s.replace(/^0/, '')
  if (!/^\+\d{8,15}$/.test(s)) fail('Numéro de téléphone invalide')
  return s
}

// Digits, optional thousands spaces, at most one decimal separator and no more decimals than the currency allows.
export function toMinor(text, cur) {
  const s = String(text ?? '').trim().replace(/[\s  ]/g, '')
  const re = cur.decimals ? new RegExp(`^\\d{1,12}([.,]\\d{1,${cur.decimals}})?$`) : /^\d{1,13}$/
  if (!re.test(s)) fail(cur.decimals ? `Montant invalide (au plus ${cur.decimals} décimales)` : 'Montant invalide (sans décimales)')
  const [whole, frac = ''] = s.split(/[.,]/)
  const minor = Number(BigInt(whole) * 10n ** BigInt(cur.decimals) + BigInt(frac.padEnd(cur.decimals, '0') || '0'))
  if (minor <= 0) fail('Montant invalide')
  if (minor > 1e12) fail('Montant trop élevé')
  return minor
}

export function fmt(minor, cur, locale = 'fr-FR') {
  const major = minor / 10 ** cur.decimals
  const digits = Number.isInteger(major) ? 0 : cur.decimals
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major)} ${cur.symbol}`
}
export const money = (minor, code) => fmt(minor, CURRENCIES[code])

// Rate from -> to, as an integer scaled by 1e8.
export function rateE8(from, to) {
  return (FX_E8_PER_EUR[to] * 100000000n) / FX_E8_PER_EUR[from]
}
// Converts minor units exactly. round: 'down' when computing what someone receives, 'up' when computing what someone pays.
export function convert(minor, from, to, round = 'down') {
  if (from === to) return minor
  const num = BigInt(minor) * FX_E8_PER_EUR[to] * 10n ** BigInt(CURRENCIES[to].decimals)
  const den = FX_E8_PER_EUR[from] * 10n ** BigInt(CURRENCIES[from].decimals)
  const q = num / den
  return Number(round === 'up' && q * den !== num ? q + 1n : q)
}
export const formatRate = (from, to) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(rateE8(from, to)) / 1e8)

// Shows "Ibrahima S." instead of a full name to anyone who is not the person.
export function mask(name) {
  const parts = String(name ?? '').trim().split(/\s+/)
  if (parts.length < 2) return parts[0] || '—'
  return `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`
}

export function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return "Aujourd'hui"
  if (days === 1) return 'Hier'
  if (days < 30) return `Il y a ${days} jours`
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(iso))
}
export const longDate = d => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(d))

// Stable JSON for hashing requests and reviews.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
