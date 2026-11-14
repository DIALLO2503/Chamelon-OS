import { useCallback, useEffect, useState } from 'react'
import { api, uploadImage, imageUrl } from '../api.js'
import Icon from '../ui/Icon.jsx'

const INPUTS = { tel: { type: 'tel', inputMode: 'tel', autoComplete: 'tel' }, amount: { type: 'text', inputMode: 'decimal' }, text: { type: 'text' } }

function ProofPhoto({ id, token }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let url, live = true
    imageUrl(id, { publicToken: token }).then(u => { url = u; if (live) setSrc(u) }).catch(() => {})
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [id, token])
  return src ? <img className="pub-photo" src={src} alt="Photo du chantier" /> : <div className="pub-photo pub-photo-empty" aria-hidden="true" />
}

function UploadField({ field, value, onChange, token }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function pick(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setError('')
    try { onChange((await uploadImage(file, { publicToken: token })).id) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const id = `pub-${field.name}`
  return (
    <div className="field">
      <span className="pub-label">{field.label}{field.required === false ? ' (facultatif)' : ''}</span>
      <label htmlFor={id} className={`pub-upload ${value ? 'done' : ''}`}>
        <Icon name={value ? 'circle-check' : 'camera'} size={22} />
        <span>{busy ? 'Envoi de la photo…' : value ? 'Photo ajoutée. Toucher pour la remplacer' : 'Prendre ou choisir une photo'}</span>
      </label>
      <input id={id} className="pub-file" type="file" accept="image/*" capture="environment" onChange={pick} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

// One action from start to finish: fields, then (if needed) the code sent to the phone, then the result.
function ActionPanel({ action, token, phone, onDone, onCancel }) {
  const [values, setValues] = useState({})
  const [step, setStep] = useState('fields')
  const [code, setCode] = useState('')
  const [sandboxCode, setSandboxCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const missing = action.fields.some(f => f.required !== false && !values[f.name])
  const set = name => v => setValues(s => ({ ...s, [name]: v }))

  async function run(fn) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const askCode = () => run(async () => {
    const r = await api(`/public/${token}/otp`, { body: {} })
    setSandboxCode(r.sandboxCode ?? ''); setCode(''); setStep('code')
  })
  const submit = () => run(async () => {
    const r = await api(`/public/${token}/act`, { body: { action: action.id, code: action.otp ? code : undefined, input: values } })
    try { navigator.vibrate?.(300) } catch {}
    onDone(r.message)
  })

  return (
    <div className="card pub-panel">
      <div className="pub-panel-head">
        <strong>{action.label}</strong>
        <button className="ibtn" onClick={onCancel} aria-label="Annuler"><Icon name="x" /></button>
      </div>

      {step === 'fields' && (
        <form className="pub-form" onSubmit={e => { e.preventDefault(); action.otp ? askCode() : submit() }}>
          {action.fields.map(f => f.type === 'upload'
            ? <UploadField key={f.name} field={f} value={values[f.name]} onChange={set(f.name)} token={token} />
            : (
              <div className="field" key={f.name}>
                <label htmlFor={`pub-${f.name}`}>{f.label}{f.required === false ? ' (facultatif)' : ''}</label>
                <input id={`pub-${f.name}`} {...INPUTS[f.type] ?? INPUTS.text} value={values[f.name] ?? ''} onChange={e => set(f.name)(e.target.value)} />
              </div>
            ))}
          {action.otp && <p className="muted">Pour confirmer que c’est bien vous, nous envoyons un code à 6 chiffres au {phone}.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="cta" disabled={busy || missing}>{busy ? 'Un instant…' : action.otp ? 'Recevoir le code' : action.label}</button>
        </form>
      )}

      {step === 'code' && (
        <form className="pub-form" onSubmit={e => { e.preventDefault(); submit() }}>
          <div className="field">
            <label htmlFor="pub-code">Code envoyé au {phone}</label>
            <input id="pub-code" className="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </div>
          {sandboxCode && <p className="info">Bac à sable : aucun SMS n’est envoyé. Votre code est <button type="button" className="link" onClick={() => setCode(sandboxCode)}>{sandboxCode}</button>.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="cta" disabled={busy || code.length < 6}>{busy ? 'Un instant…' : `Confirmer : ${action.label}`}</button>
          <button type="button" className="cta quiet" disabled={busy} onClick={askCode}>Renvoyer le code</button>
        </form>
      )}
    </div>
  )
}

export default function PublicPage({ token }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [active, setActive] = useState(null)
  const [message, setMessage] = useState('')

  const load = useCallback(() => {
    api(`/public/${token}`).then(v => { setView(v); setError('') }).catch(e => setError(e.message))
  }, [token])
  useEffect(load, [load])

  const done = msg => { setActive(null); setMessage(msg); load() }

  return (
    <div className="shell pub">
      <div className="screen pub-screen">
        <header className="pub-brand">
          <span className="brand">Nexus</span>
          <span className="muted">Vous n’avez pas besoin d’installer d’application</span>
        </header>

        {!view && !error && <div className="skeleton" style={{ height: 220 }} aria-busy="true" />}
        {error && !view && (
          <div className="card pub-empty">
            <Icon name="triangle-alert" size={28} />
            <p>{error}</p>
            <p className="muted">Demandez à la personne qui vous a envoyé ce lien de vous en renvoyer un.</p>
          </div>
        )}

        {view && (
          <>
            <section className="pub-head">
              <h1 className="screen-title">{view.title}</h1>
              {view.status && <span className="pill wait">{view.status}</span>}
            </section>

            <dl className="card pub-lines">
              {view.lines.map(([label, value], i) => (
                <div key={i} className="pub-line"><dt>{label}</dt><dd className="num">{value}</dd></div>
              ))}
            </dl>

            {view.proof?.length > 0 && (
              <section className="sec">
                <h2>Photos de l’étape</h2>
                <div className="pub-photos">{view.proof.map(id => <ProofPhoto key={id} id={id} token={token} />)}</div>
              </section>
            )}

            {message && (
              <div className="card pub-success" role="status">
                <Icon name="circle-check" size={28} />
                <p>{message}</p>
              </div>
            )}

            {active
              ? <ActionPanel action={active} token={token} phone={view.phone} onDone={done} onCancel={() => setActive(null)} />
              : view.actions.length > 0 && (
                <div className="pub-actions">
                  {view.actions.map(a => (
                    <button key={a.id} className={`cta ${a.tone === 'primary' ? '' : 'quiet'}`} onClick={() => { setMessage(''); setActive(a) }}>{a.label}</button>
                  ))}
                </div>
              )}

            {!active && view.actions.length === 0 && !message && <p className="muted pub-note">Rien à faire pour le moment. Vous recevrez un message quand une action sera attendue.</p>}
            <p className="muted pub-note">Ce lien vous est personnel. Ne le transférez pas.</p>
          </>
        )}
      </div>
    </div>
  )
}
