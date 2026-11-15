import { useState } from 'react'
import Icon from './Icon.jsx'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

// Numeric keypad for the secret code: large keys, dots instead of digits, submits at 4 digits (or on OK up to 6).
export default function PinPad({ label, onSubmit, busy, error, length = 4 }) {
  const [pin, setPin] = useState('')
  const press = k => {
    if (busy) return
    if (k === 'del') return setPin(p => p.slice(0, -1))
    const next = (pin + k).slice(0, 6)
    setPin(next)
    if (next.length === length) { onSubmit(next); setPin('') }
  }
  return (
    <div className="pin">
      <div className="pin-label"><Icon name="lock" size={18} />{label}</div>
      <div className="pin-dots" aria-label={`${pin.length} chiffres saisis`}>{Array.from({ length }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="pad">
        {KEYS.map(k => k === '' ? <span key="spacer" /> : (
          <button type="button" key={k} disabled={busy} aria-label={k === 'del' ? 'Effacer' : k} onClick={() => press(k)}>{k === 'del' ? <Icon name="delete" size={24} /> : k}</button>
        ))}
      </div>
    </div>
  )
}
