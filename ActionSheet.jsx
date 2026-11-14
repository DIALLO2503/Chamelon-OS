import { useEffect, useRef, useState } from 'react'
import { api, uploadImage } from '../api.js'
import { useApp } from '../App.jsx'
import Icon from './Icon.jsx'
import PinPad from './PinPad.jsx'
import { CopyButton, ShareButtons, thud } from './Blocks.jsx'

const INPUT = { tel: { type: 'tel', inputMode: 'tel' }, amount: { type: 'text', inputMode: 'decimal' }, number: { type: 'text', inputMode: 'numeric' }, date: { type: 'date' }, text: { type: 'text' } }

function PhotoField({ field, value, onChange }) {
  const [state, setState] = useState(value ? 'done' : 'idle')
  const [error, setError] = useState('')
  async function pick(e) {
    const file = e.target.files?.[0]; if (!file) return
    setState('busy'); setError('')
    try { onChange((await uploadImage(file)).id); setState('done') } catch (err) { setError(err.message); setState('idle') }
  }
  return (
    <div className="field">
      <span className="label">{field.label}{field.required === false ? ' (facultatif)' : ''}</span>
      <label className={`photo-pick ${state}`}>
        <input type="file" accept="image/*" capture="environment" onChange={pick} hidden />
        <Icon name={state === 'done' ? 'circle-check' : 'camera'} size={22} />
        {state === 'busy' ? 'Envoi de la photo…' : state === 'done' ? 'Photo ajoutée · changer' : 'Prendre une photo'}
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Field({ field, value, onChange, symbol }) {
  const id = `f-${field.name}`
  if (field.type === 'upload') return <PhotoField field={field} value={value} onChange={onChange} />
  if (field.type === 'select') return (
    <fieldset className="field">
      <legend>{field.label}{field.required === false ? ' (facultatif)' : ''}</legend>
      <div className="options">
        {field.options.map(o => <button type="button" key={o.value} className={`option ${value === o.value ? 'on' : ''}`} aria-pressed={value === o.value} onClick={() => onChange(value === o.value && field.required === false ? undefined : o.value)}>{o.label}</button>)}
      </div>
    </fieldset>
  )
  return (
    <div className={`field ${field.type === 'amount' ? 'amount' : ''}`}>
      <label htmlFor={id}>{field.label}{field.required === false ? ' (facultatif)' : ''}</label>
      <div className="input-wrap">
        <input id={id} {...INPUT[field.type]} value={value ?? ''} placeholder={field.placeholder ?? (field.type === 'amount' ? '0' : '')} onChange={e => onChange(e.target.value)} autoComplete="off" />
        {field.type === 'amount' && !field.currencyField && <span className="suffix">{symbol}</span>}
      </div>
      {field.hint && <p className="hint">{field.hint}</p>}
    </div>
  )
}

// One sheet for every action: the server sends the form; money actions return a quote to confirm with the secret code.
export default function ActionSheet({ module, action, row, onClose, onDone }) {
  const { me } = useApp()
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [step, setStep] = useState('form')
  const [quote, setQuote] = useState(null)
  const [done, setDone] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const runKey = useRef(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
  const confirmKey = useRef(null)
  const path = `/modules/${module}/actions/${action}`

  const finish = d => { thud(); setDone(d); setStep('done'); onDone() }

  async function submit() {
    setBusy(true); setError('')
    try {
      const res = await api(path, { body: { row, input: values }, idem: runKey.current })
      if (res.intentId) { setQuote(res); confirmKey.current = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()); setStep('review') } else finish(res.done)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function confirm(pin) {
    setBusy(true); setError('')
    try { finish((await api(`/intents/${quote.intentId}/confirm`, { body: { pin }, idem: confirmKey.current })).done) }
    catch (e) {
      setError(e.message)
      if (e.status === 409) { setQuote(null); setStep('form') }
    } finally { setBusy(false) }
  }

  useEffect(() => {
    api(`${path}${row ? `?row=${encodeURIComponent(row)}` : ''}`).then(f => {
      setForm(f)
      setValues(Object.fromEntries(f.fields.filter(x => x.type === 'select' && x.options.length === 1 && x.required !== false).map(x => [x.name, x.options[0].value])))
    }).catch(e => setError(e.message))
  }, [path, row])
  // An action with nothing to fill in goes straight to its review, or straight to the result.
  useEffect(() => { if (form && !form.blocked && form.fields.length === 0) submit() }, [form])

  const missing = form?.fields.some(f => f.required !== false && !values[f.name])
  const close = () => onClose(step === 'done')
  return (
    <div className="scrim" onClick={close}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={form?.title} onClick={e => e.stopPropagation()}>
        <header><h2>{form?.title ?? ' '}</h2><button className="ibtn" aria-label="Fermer" onClick={close}><Icon name="x" /></button></header>

        {step === 'form' && form && (
          <form onSubmit={e => { e.preventDefault(); submit() }}>
            {form.info && <p className="info">{form.info}</p>}
            {form.fields.map(f => <Field key={f.name} field={f} value={values[f.name]} symbol={me.experience.region.currency.symbol} onChange={v => setValues(s => ({ ...s, [f.name]: v }))} />)}
            {error && <p className="error" role="alert">{error}</p>}
            {form.blocked ? <button type="button" className="cta quiet" onClick={close}>Fermer</button>
              : form.fields.length > 0 && <button className="cta" disabled={busy || missing}>{form.needsReview ? 'Voir le récapitulatif' : 'Enregistrer'}</button>}
            {!form.blocked && form.fields.length === 0 && busy && <div className="skeleton" style={{ height: 60 }} />}
          </form>
        )}

        {step === 'review' && quote && (
          <>
            <dl className="review">{quote.review.lines.map(([label, value, strong]) => <div key={label} className={strong ? 'strong' : ''}><dt>{label}</dt><dd className="num">{value}</dd></div>)}</dl>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="cta" disabled={busy} onClick={() => { setError(''); setStep('pin') }}><Icon name="lock" size={18} /> {quote.review.cta}</button>
            {form.fields.length > 0 && <button className="cta quiet" disabled={busy} onClick={() => { setStep('form'); setError('') }}>Modifier</button>}
            <p className="hint center">Ce récapitulatif est valable 10 minutes.</p>
          </>
        )}

        {step === 'pin' && <PinPad label="Code secret pour confirmer" busy={busy} error={error} onSubmit={confirm} />}

        {step === 'done' && done && (
          <>
            <div className="done"><Icon name="circle-check" size={44} /><p>{done.message}</p>{done.copy && <CopyButton text={done.copy} label={done.copy} />}</div>
            {done.share && <ShareButtons share={done.share} />}
            <button className="cta quiet" onClick={close}>Terminé</button>
          </>
        )}

        {!form && !error && <div className="skeleton" style={{ height: 120 }} />}
        {!form && error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
