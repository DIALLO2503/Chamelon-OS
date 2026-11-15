import { useEffect, useState } from 'react'
import { api, session } from './api.js'
import Icon from './ui/Icon.jsx'
import PinPad from './ui/PinPad.jsx'

// New phone: code → country → profile → name → secret code (twice). Known phone: code → secret code.
export default function Auth({ onDone }) {
  const [regions, setRegions] = useState([])
  const [sandbox, setSandbox] = useState({ accounts: [] })
  const [step, setStep] = useState('phone')
  const [dial, setDial] = useState('')
  const [number, setNumber] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sandboxCode, setSandboxCode] = useState('')
  const [tokens, setTokens] = useState({})
  const [returning, setReturning] = useState('')
  const [regionId, setRegionId] = useState('')
  const [personaId, setPersonaId] = useState('')
  const [name, setName] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [terms, setTerms] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const region = regions.find(r => r.id === regionId)
  const persona = region?.personas.find(p => p.id === personaId)

  useEffect(() => {
    api('/config/regions').then(({ regions }) => { setRegions(regions); setDial(regions[0].dialCode) }).catch(e => setError(e.message))
    api('/config/sandbox').then(setSandbox).catch(() => {})
  }, [])

  async function run(fn) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const finish = token => { session.set(token); onDone() }
  const requestCode = full => run(async () => {
    const res = await api('/auth/otp', { body: { phone: full } })
    setPhone(full); setCode(''); setSandboxCode(res.sandboxCode ?? ''); setStep('code')
  })
  const verify = () => run(async () => {
    const res = await api('/auth/verify', { body: { phone, code } })
    if (res.pinToken) { setTokens({ pin: res.pinToken }); setReturning(res.name); setStep('pin') }
    else {
      setTokens({ signup: res.signupToken })
      const match = regions.find(r => phone.startsWith(r.dialCode))
      if (match) setRegionId(match.id)
      setStep(match ? 'persona' : 'region')
    }
  })
  const login = pin => run(async () => finish((await api('/auth/pin', { body: { pinToken: tokens.pin, pin } })).accessToken))
  const resetPin = pin => run(async () => {
    if (pin !== firstPin) { setFirstPin(''); setStep('reset1'); throw new Error('Les deux codes ne sont pas identiques. Recommencez.') }
    finish((await api('/auth/pin/reset', { body: { pinToken: tokens.pin, pin } })).accessToken)
  })
  const register = pin => run(async () => {
    if (pin !== firstPin) { setFirstPin(''); setStep('pin1'); throw new Error('Les deux codes ne sont pas identiques. Recommencez.') }
    finish((await api('/auth/register', { body: { signupToken: tokens.signup, name: name.trim(), region: regionId, persona: personaId, pin, terms } })).accessToken)
  })

  return (
    <div className="shell auth" style={{ '--hue': persona?.hue }}>
      <div className="screen">
        <div className="brand">Nexus</div>

        {step === 'phone' && (
          <form onSubmit={e => { e.preventDefault(); requestCode(dial + number.replace(/\s/g, '').replace(/^0/, '')) }}>
            <h1 className="screen-title">Votre numéro de téléphone</h1>
            <div className="field">
              <label htmlFor="auth-number">Nous vous envoyons un code pour vérifier que c’est bien vous.</label>
              <div className="phone-row">
                <select aria-label="Indicatif du pays" value={dial} onChange={e => setDial(e.target.value)}>{regions.map(r => <option key={r.id} value={r.dialCode}>{r.dialCode} {r.name}</option>)}</select>
                <input id="auth-number" type="tel" inputMode="tel" autoComplete="tel-national" value={number} onChange={e => setNumber(e.target.value)} />
              </div>
            </div>
            <button className="cta" disabled={busy || number.replace(/\D/g, '').length < 6}>Recevoir le code</button>
            {sandbox.accounts.length > 0 && (
              <section className="sec">
                <h2>Comptes de démonstration</h2>
                <p className="muted">Bac à sable : argent fictif, partenaire simulé. Code secret de tous les comptes : <strong>{sandbox.pin}</strong>.</p>
                <div className="card">
                  {sandbox.accounts.map(a => (
                    <button type="button" key={a.phone} className="row row-main" disabled={busy} onClick={() => requestCode(a.phone)}>
                      <div className="grow"><div className="row-title">{a.name}</div><div className="muted">{a.label}</div></div><Icon name="chevron-right" size={16} />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={e => { e.preventDefault(); verify() }}>
            <h1 className="screen-title">Entrez le code</h1>
            <div className="field">
              <label htmlFor="auth-code">Code à 6 chiffres envoyé au {phone}</label>
              <input id="auth-code" className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            {sandboxCode && <p className="info">Bac à sable : aucun SMS n’est envoyé. Votre code est <button type="button" className="link" onClick={() => setCode(sandboxCode)}>{sandboxCode}</button>.</p>}
            <button className="cta" disabled={busy || code.length < 6}>Valider</button>
            <button type="button" className="cta quiet" onClick={() => { setStep('phone'); setError('') }}>Changer de numéro</button>
          </form>
        )}

        {step === 'pin' && (
          <>
            <h1 className="screen-title">Bonjour {returning.split(' ')[0]}</h1>
            <PinPad label="Votre code secret" busy={busy} error={error} onSubmit={login} />
            <button type="button" className="cta quiet" disabled={busy} onClick={() => { setFirstPin(''); setError(''); setStep('reset1') }}>Code secret oublié ?</button>
          </>
        )}
        {step === 'reset1' && (
          <>
            <h1 className="screen-title">Nouveau code secret</h1>
            <p className="muted">Votre numéro vient d’être vérifié. Par sécurité, les paiements seront suspendus pendant 24 heures après le changement ; vous pourrez consulter votre compte.</p>
            <PinPad label="Nouveau code secret" busy={busy} error={error} onSubmit={pin => { setFirstPin(pin); setError(''); setStep('reset2') }} />
            <button type="button" className="cta quiet" disabled={busy} onClick={() => { setError(''); setStep('pin') }}>Retour</button>
          </>
        )}
        {step === 'reset2' && (
          <>
            <h1 className="screen-title">Confirmez votre code</h1>
            <PinPad label="Saisissez-le à nouveau" busy={busy} error={error} onSubmit={resetPin} />
          </>
        )}

        {step === 'region' && (
          <>
            <h1 className="screen-title">Où vivez-vous ?</h1>
            <p className="muted">Votre pays décide des services, de la devise et des profils proposés. Le numéro doit être de ce pays.</p>
            <div className="options">
              {regions.map(r => (
                <button key={r.id} className={`option ${regionId === r.id ? 'on' : ''}`} aria-pressed={regionId === r.id} onClick={() => { setRegionId(r.id); setPersonaId('') }}>
                  <strong>{r.name}</strong><span className="muted">{r.currency.code} · {r.personas.length} profils · {r.custody === 'held' ? 'avec partenaire de paiement' : 'paiements en direct, preuves dans Nexus'}</span>
                </button>
              ))}
            </div>
            <button className="cta" disabled={!regionId} onClick={() => setStep('persona')}>Continuer</button>
          </>
        )}

        {step === 'persona' && region && (
          <form onSubmit={e => { e.preventDefault(); setStep('pin1') }}>
            <h1 className="screen-title">Que faites-vous en {region.name} ?</h1>
            <div className="options">
              {region.personas.map(p => (
                <button type="button" key={p.id} className={`option with-icon ${personaId === p.id ? 'on' : ''}`} aria-pressed={personaId === p.id} style={{ '--hue': p.hue }} onClick={() => setPersonaId(p.id)}>
                  <span className="disc soft"><Icon name={p.icon} /></span>
                  <span className="grow"><strong>{p.label}</strong><span className="muted">{p.tagline}</span>{p.restricted && <span className="pill wait">Sur agrément</span>}</span>
                </button>
              ))}
            </div>
            {persona?.restricted && <p className="info">Ce profil est vérifié par notre équipe avant activation des opérations clients.</p>}
            <div className="field"><label htmlFor="auth-name">Prénom et nom</label><input id="auth-name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></div>
            <label className="consent">
              <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} />
              <span>J’accepte les <a href="/legal.html" target="_blank" rel="noopener">conditions d’utilisation et la politique de confidentialité</a>.</span>
            </label>
            <button className="cta" disabled={!personaId || name.trim().length < 2 || !terms}>Continuer</button>
            <button type="button" className="cta quiet" onClick={() => setStep('region')}>Changer de pays</button>
          </form>
        )}

        {step === 'pin1' && (
          <>
            <h1 className="screen-title">Choisissez votre code secret</h1>
            <p className="muted">4 chiffres. Il vous sera demandé pour chaque paiement. Ne le donnez à personne, même à un agent Nexus.</p>
            <PinPad label="Nouveau code secret" busy={busy} error={error} onSubmit={pin => { setFirstPin(pin); setError(''); setStep('pin2') }} />
          </>
        )}
        {step === 'pin2' && (
          <>
            <h1 className="screen-title">Confirmez votre code</h1>
            <PinPad label="Saisissez-le à nouveau" busy={busy} error={error} onSubmit={register} />
          </>
        )}

        {error && !['pin', 'pin1', 'pin2', 'reset1', 'reset2'].includes(step) && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
