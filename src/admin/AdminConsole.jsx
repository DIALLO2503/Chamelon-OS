import { useCallback, useEffect, useState } from 'react'
import { api, imageUrl, download } from '../api.js'
import Icon from '../ui/Icon.jsx'

const TABS = [['overview', 'Vue d’ensemble'], ['pilot', 'Pilote'], ['users', 'Utilisateurs'], ['disputes', 'Litiges'], ['adjustments', 'Ajustements'], ['ops', 'Opérations']]
const when = iso => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

function useLoad(path, deps = []) {
  const [state, setState] = useState({ data: null, error: '' })
  const reload = useCallback(() => {
    if (!path) return
    api(path).then(data => setState({ data, error: '' })).catch(e => setState(s => ({ ...s, error: e.message })))
  }, [path, ...deps])
  useEffect(reload, [reload])
  return { ...state, reload }
}

// A button that runs one admin call, shows its result inline and asks for a second tap when `confirm` is set.
function ActionButton({ label, run, confirm, tone, disabled, onDone }) {
  const [armed, setArmed] = useState(false)
  const [state, setState] = useState({ busy: false, error: '', ok: '' })
  async function go() {
    if (confirm && !armed) return setArmed(true)
    setState({ busy: true, error: '', ok: '' })
    try { await run(); setState({ busy: false, error: '', ok: 'Fait' }); setArmed(false); onDone?.() } catch (e) { setState({ busy: false, error: e.message, ok: '' }); setArmed(false) }
  }
  return (
    <span className="adm-act">
      <button className={`chip-btn ${tone === 'primary' ? 'primary' : ''} ${tone === 'bad' ? 'adm-danger' : ''}`} disabled={disabled || state.busy} onClick={go}>
        {state.busy ? '…' : armed ? `Confirmer : ${label}` : label}
      </button>
      {armed && <button className="chip-btn" onClick={() => setArmed(false)}>Annuler</button>}
      {state.error && <span className="error adm-inline">{state.error}</span>}
      {state.ok && <span className="adm-ok">{state.ok}</span>}
    </span>
  )
}

const Field = ({ label, id, children }) => <div className="field"><label htmlFor={id}>{label}</label>{children}</div>
const Err = ({ msg }) => (msg ? <p className="error" role="alert">{msg}</p> : null)

/* ---------------- overview ---------------- */
function Overview() {
  const { data, error, reload } = useLoad('/admin/overview')
  if (!data) return error ? <Err msg={error} /> : <div className="skeleton" style={{ height: 160 }} />
  const c = data.counts
  const tiles = [
    ['Utilisateurs', c.users, ''], ['Rôles à valider', c.pending_roles, c.pending_roles ? 'wait' : ''], ['Litiges ouverts', c.disputes, c.disputes ? 'wait' : ''],
    ['Tâches en échec', c.failed_jobs, c.failed_jobs ? 'bad' : ''], ['Ajustements à approuver', c.adjustments, c.adjustments ? 'wait' : ''], ['Comptes suspendus', c.frozen, c.frozen ? 'bad' : ''],
  ]
  return (
    <>
      <div className="adm-tiles">{tiles.map(([l, v, tone]) => <div key={l} className={`kpi adm-tile ${tone}`}><span className="muted">{l}</span><b className={`num ${tone}`}>{v}</b></div>)}</div>
      <section className="sec">
        <h2>Rapprochement du grand livre</h2>
        <div className={`card adm-status ${data.reconciliation.ok ? 'ok' : 'bad'}`}>
          <Icon name={data.reconciliation.ok ? 'circle-check' : 'triangle-alert'} size={22} />
          <div>{data.reconciliation.ok ? 'Tous les soldes correspondent à leurs écritures.' : `${data.reconciliation.mismatches.length} compte(s) en écart. À traiter immédiatement.`}</div>
        </div>
        {!data.reconciliation.ok && (
          <div className="card adm-table-wrap"><table className="adm-table"><thead><tr><th>Compte</th><th>Devise</th><th>Solde</th><th>Écritures</th></tr></thead>
            <tbody>{data.reconciliation.mismatches.map(m => <tr key={m.id}><td>{m.owner} · {m.kind}</td><td>{m.currency}</td><td className="num">{m.balance}</td><td className="num">{m.posted}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <section className="sec">
        <h2>Cantonnement des fonds clients</h2>
        <p className="muted">L’argent dû aux clients doit être couvert par les fonds détenus chez le partenaire, devise par devise.</p>
        <div className="card">
          {data.safeguarding.map(s => (
            <div key={s.currency} className="row"><div className="row-main">
              <span className={`disc small ${s.ok ? 'in' : 'adm-disc-bad'}`}><Icon name={s.ok ? 'check' : 'triangle-alert'} size={18} /></span>
              <div className="grow"><div className="row-title">{s.currency}</div><div className="muted">Dû aux clients {s.owedText} · détenu {s.heldText}</div></div>
              <span className={`pill ${s.ok ? 'ok' : 'bad'}`}>{s.ok ? 'Couvert' : 'Non couvert'}</span>
            </div></div>
          ))}
        </div>
      </section>
      <button className="chip-btn" onClick={reload}><Icon name="rotate-ccw" size={16} />Actualiser</button>
    </>
  )
}

/* ---------------- users ---------------- */
function UserSearch({ onPick, compact }) {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const { data, error } = useLoad(`/admin/users?${new URLSearchParams({ q: term })}`, [term])
  return (
    <div className="adm-search">
      <form className="adm-search-row" onSubmit={e => { e.preventDefault(); setTerm(q) }}>
        <input aria-label="Rechercher par nom ou numéro" placeholder="Nom ou numéro" value={q} onChange={e => setQ(e.target.value)} />
        <button className="chip-btn primary"><Icon name="search" size={16} />Chercher</button>
      </form>
      <Err msg={error} />
      <div className="card">
        {data?.users.length === 0 && <div className="row muted">Aucun résultat.</div>}
        {data?.users.slice(0, compact ? 6 : 50).map(u => {
          const pending = u.roles.some(r => r.status === 'pending')
          return (
            <button key={u.id} className={`row row-main adm-user ${pending ? 'adm-pending' : ''}`} onClick={() => onPick(u)}>
              <div className="grow"><div className="row-title">{u.name}</div><div className="muted">{u.phone} · {u.region} · {u.persona} · KYC {u.kyc_level}</div></div>
              {pending && <span className="pill wait">Rôle à valider</span>}
              {u.frozen && <span className="pill bad">Suspendu</span>}
              <Icon name="chevron-right" size={16} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function UserDetail({ id, onBack }) {
  const { data, error, reload } = useLoad(`/admin/users/${id}`)
  const [reason, setReason] = useState('')
  const [level, setLevel] = useState('')
  if (!data) return error ? <Err msg={error} /> : <div className="skeleton" style={{ height: 160 }} />
  const u = data.user
  const agent = data.roles.find(r => r.role === 'agent')
  const needReason = !reason.trim()
  return (
    <>
      <button className="chip-btn" onClick={onBack}><Icon name="chevron-left" size={16} />Retour à la liste</button>
      <div className="card adm-detail">
        <div className="row-title">{u.name} {u.frozen && <span className="pill bad">Suspendu</span>}</div>
        <div className="muted">{u.phone} · {u.region} · {u.persona} · KYC niveau {u.kyc_level} · inscrit le {when(u.created_at)}</div>
        <div className="adm-chips">{data.roles.map(r => <span key={r.role} className={`pill ${r.status === 'active' ? 'ok' : r.status === 'pending' ? 'wait' : ''}`}>{r.role} · {r.status}</span>)}</div>
      </div>
      <section className="sec">
        <h2>Comptes</h2>
        <div className="card">{data.accounts.length ? data.accounts.map(a => <div key={a.kind + a.currency} className="row"><div className="row-main"><div className="grow">{a.kind} · {a.currency}</div><b className="num">{a.text}</b></div></div>) : <div className="row muted">Aucun compte.</div>}</div>
      </section>
      <section className="sec">
        <h2>Décisions</h2>
        <div className="card adm-form">
          <Field label="Motif (obligatoire, conservé dans le journal)" id="adm-reason"><input id="adm-reason" value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <div className="adm-buttons">
            <ActionButton label={u.frozen ? 'Lever la suspension' : 'Suspendre le compte'} tone={u.frozen ? '' : 'bad'} confirm disabled={needReason}
              run={() => api(`/admin/users/${u.id}/freeze`, { body: { frozen: !u.frozen, reason } })} onDone={reload} />
          </div>
          <div className="adm-search-row">
            <select aria-label="Niveau KYC" value={level} onChange={e => setLevel(e.target.value)}>
              <option value="">Niveau KYC…</option><option value="0">0 · téléphone</option><option value="1">1 · identité vérifiée</option><option value="2">2 · renforcé</option>
            </select>
            <ActionButton label="Appliquer le niveau" disabled={needReason || level === ''} run={() => api(`/admin/users/${u.id}/kyc`, { body: { level: Number(level), reason } })} onDone={reload} />
          </div>
          {agent && (
            <div className="adm-buttons">
              {agent.status !== 'active' && <ActionButton label="Valider l’agrément d’agent" tone="primary" confirm run={() => api(`/admin/users/${u.id}/roles/agent`, { body: { status: 'active' } })} onDone={reload} />}
              {agent.status === 'active' && <ActionButton label="Retirer l’agrément d’agent" tone="bad" confirm run={() => api(`/admin/users/${u.id}/roles/agent`, { body: { status: 'revoked' } })} onDone={reload} />}
            </div>
          )}
        </div>
      </section>
      <section className="sec">
        <h2>Journal récent</h2>
        <div className="card">{data.events.map((e, i) => <div key={i} className="row"><div className="row-main"><div className="grow"><div>{e.action}</div><div className="muted">{e.actor_type} · {e.object_type ?? ''} {e.object_id ?? ''}</div></div><span className="muted">{when(e.created_at)}</span></div></div>)}</div>
      </section>
    </>
  )
}

function Users() {
  const [picked, setPicked] = useState(null)
  return picked ? <UserDetail id={picked.id} onBack={() => setPicked(null)} /> : <UserSearch onPick={setPicked} />
}

/* ---------------- pilot ---------------- */
const KIND_LABEL = { job: 'Chantier', order: 'Commande', escrow: 'Paiement protégé', recorded: 'Paiement signalé', tontine: 'Tontine', statement: 'Carnet de crédit' }
const rate = (n, pct) => (pct === null ? String(n) : `${n} (${pct} %)`)
function Pilot() {
  const { data, error } = useLoad('/admin/funnel')
  if (!data) return error ? <Err msg={error} /> : <div className="skeleton" style={{ height: 160 }} />
  return (
    <>
      <section className="sec">
        <h2>Comptes par pays</h2>
        <div className="card adm-table-wrap"><table className="adm-table"><thead><tr><th>Pays</th><th>Comptes</th><th>Nouveaux ({data.days} j)</th><th>Actifs (7 j)</th></tr></thead>
          <tbody>{data.users.map(u => <tr key={u.region}><td>{u.regionName}</td><td className="num">{u.users}</td><td className="num">{u.new_users}</td><td className="num">{u.active_7d}</td></tr>)}</tbody></table></div>
      </section>
      <section className="sec">
        <h2>Liens envoyés, {data.days} derniers jours</h2>
        <p className="muted">Une ligne par pays du destinataire et par type. Un lien renvoyé plusieurs fois à la même personne compte une fois.</p>
        <div className="card adm-table-wrap"><table className="adm-table"><thead><tr><th>Pays</th><th>Type</th><th>Personnes invitées</th><th>Ont ouvert</th><th>Ont agi</th><th>Se sont inscrites</th></tr></thead>
          <tbody>
            {data.links.length === 0 && <tr><td colSpan={6} className="muted">Aucun lien envoyé sur la période.</td></tr>}
            {data.links.map(l => <tr key={l.region + l.kind}><td>{l.regionName}</td><td>{KIND_LABEL[l.kind] ?? l.kind}</td><td className="num">{l.sent}</td><td className="num">{rate(l.opened, l.openRate)}</td><td className="num">{rate(l.acted, l.actRate)}</td><td className="num">{rate(l.signed_up, l.signupRate)}</td></tr>)}
          </tbody></table></div>
      </section>
    </>
  )
}

/* ---------------- disputes ---------------- */
function Photo({ id }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let url, live = true
    imageUrl(id).then(u => { url = u; if (live) setSrc(u) }).catch(() => {})
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [id])
  return src ? <img className="pub-photo" src={src} alt="Preuve" /> : <div className="pub-photo pub-photo-empty" aria-hidden="true" />
}

const OUTCOMES = { release: 'Verser au bénéficiaire', refund: 'Rembourser le payeur', split: 'Partager' }

function DisputeDetail({ id, onBack }) {
  const { data, error, reload } = useLoad(`/admin/disputes/${id}`)
  const [outcome, setOutcome] = useState('release')
  const [payee, setPayee] = useState('')
  const [note, setNote] = useState('')
  if (!data) return error ? <Err msg={error} /> : <div className="skeleton" style={{ height: 160 }} />
  const { dispute: d, escrow: e, payer, payee: payeeParty, stage, evidence } = data
  const open = d.status !== 'resolved'
  return (
    <>
      <button className="chip-btn" onClick={onBack}><Icon name="chevron-left" size={16} />Retour aux litiges</button>
      <div className="card adm-detail">
        <div className="row-title">{e.title}</div>
        <div className="muted">Montant bloqué : <b className="num">{e.amountText}</b> · ouvert le {when(d.created_at)}</div>
        <div className="adm-parties">
          <div><span className="muted">Payeur</span><div className="row-title">{payer.name}</div><div className="muted">{payer.phone}</div></div>
          <div><span className="muted">Bénéficiaire</span><div className="row-title">{payeeParty.name}</div><div className="muted">{payeeParty.phone}</div></div>
        </div>
        <p className="info">Motif déclaré : {d.reason}</p>
      </div>
      {stage?.proof?.length > 0 && <section className="sec"><h2>Photos de l’étape</h2><div className="pub-photos">{stage.proof.map(p => <Photo key={p} id={p} />)}</div></section>}
      {evidence.length > 0 && <section className="sec"><h2>Pièces</h2><div className="card">{evidence.map(ev => <div key={ev.id} className="row"><strong>{ev.party_name} :</strong> {ev.text}{ev.upload_id && <Photo id={ev.upload_id} />}</div>)}</div></section>}
      {d.proposal && (
        <div className="card adm-proposal">
          <div className="row-title">Proposition : {OUTCOMES[d.proposal.outcome]}{d.proposal.payeeAmount ? ` (${d.proposal.payeeAmount} unités au bénéficiaire)` : ''}</div>
          <div className="muted">{d.proposal.note}</div>
          {d.status === 'resolved' && <span className="pill ok">Tranché</span>}
        </div>
      )}
      {open && (
        <section className="sec">
          <h2>Décision</h2>
          <p className="muted">Règle des deux personnes : un administrateur propose, un autre approuve. L’argent ne bouge qu’à l’approbation.</p>
          <div className="card adm-form">
            <div className="options adm-outcomes">
              {Object.entries(OUTCOMES).map(([k, l]) => <button key={k} type="button" className={`option ${outcome === k ? 'on' : ''}`} aria-pressed={outcome === k} onClick={() => setOutcome(k)}>{l}</button>)}
            </div>
            {outcome === 'split' && <Field label={`Montant au bénéficiaire, en unités mineures (sur ${e.amount} ${e.currency})`} id="adm-split"><input id="adm-split" inputMode="numeric" value={payee} onChange={x => setPayee(x.target.value.replace(/\D/g, ''))} /></Field>}
            <Field label="Motif de la décision (envoyé aux deux parties)" id="adm-note"><input id="adm-note" value={note} onChange={x => setNote(x.target.value)} /></Field>
            <div className="adm-buttons">
              <ActionButton label="Proposer" tone="primary" disabled={!note.trim() || (outcome === 'split' && !payee)}
                run={() => api(`/admin/disputes/${d.id}/propose`, { body: { outcome, note, ...(outcome === 'split' ? { payeeAmount: Number(payee) } : {}) } })} onDone={reload} />
              {d.status === 'proposed' && <ActionButton label="Approuver la proposition" confirm run={() => api(`/admin/disputes/${d.id}/approve`, { body: {} })} onDone={reload} />}
            </div>
          </div>
        </section>
      )}
    </>
  )
}

function Disputes() {
  const [picked, setPicked] = useState(null)
  const { data, error } = useLoad(picked ? null : '/admin/disputes', [picked])
  if (picked) return <DisputeDetail id={picked} onBack={() => setPicked(null)} />
  if (!data) return error ? <Err msg={error} /> : <div className="skeleton" style={{ height: 160 }} />
  const label = { open: ['Ouvert', 'wait'], proposed: ['Décision proposée', 'wait'], resolved: ['Tranché', 'ok'] }
  return (
    <div className="card">
      {data.disputes.length === 0 && <div className="row muted">Aucun litige.</div>}
      {data.disputes.map(d => (
        <button key={d.id} className="row row-main adm-user" onClick={() => setPicked(d.id)}>
          <div className="grow"><div className="row-title">{d.title}</div><div className="muted">{d.payer_name} → {d.payee_name} · {when(d.created_at)}</div><div className="muted">{d.reason}</div></div>
          <div className="row-end"><div className="row-value num">{d.amountText}</div><span className={`pill ${label[d.status][1]}`}>{label[d.status][0]}</span></div>
        </button>
      ))}
    </div>
  )
}

/* ---------------- adjustments ---------------- */
function Adjustments() {
  const { data, error, reload } = useLoad('/admin/adjustments')
  const [user, setUser] = useState(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const valid = user && /^-?\d+$/.test(amount) && Number(amount) !== 0 && reason.trim()
  return (
    <>
      <section className="sec">
        <h2>Proposer un ajustement</h2>
        <p className="muted">Crédit ou débit manuel d’un portefeuille. Un autre administrateur doit l’approuver.</p>
        <div className="card adm-form">
          {user
            ? <div className="adm-search-row"><span className="grow"><b>{user.name}</b> <span className="muted">{user.phone}</span></span><button className="chip-btn" onClick={() => setUser(null)}>Changer</button></div>
            : <UserSearch onPick={setUser} compact />}
          <Field label="Montant en unités mineures (négatif pour un débit)" id="adm-amount"><input id="adm-amount" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d-]/g, ''))} /></Field>
          <Field label="Motif (obligatoire)" id="adm-adj-reason"><input id="adm-adj-reason" value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <ActionButton label="Proposer l’ajustement" tone="primary" disabled={!valid}
            run={() => api('/admin/adjustments', { body: { userId: user.id, amount: Number(amount), reason } })} onDone={() => { setAmount(''); setReason(''); reload() }} />
        </div>
      </section>
      <section className="sec">
        <h2>Historique</h2>
        <Err msg={error} />
        <div className="card">
          {data?.adjustments.length === 0 && <div className="row muted">Aucun ajustement.</div>}
          {data?.adjustments.map(a => (
            <div key={a.id} className="row"><div className="row-main">
              <div className="grow"><div className="row-title">{a.name} · <span className="num">{a.amount > 0 ? '+' : ''}{a.amount}</span></div><div className="muted">{a.reason} · {when(a.created_at)}</div></div>
              {a.status === 'proposed' ? <ActionButton label="Approuver" confirm run={() => api(`/admin/adjustments/${a.id}/approve`, { body: {} })} onDone={reload} /> : <span className="pill ok">Approuvé</span>}
            </div></div>
          ))}
        </div>
      </section>
    </>
  )
}

/* ---------------- operations ---------------- */
function LinkRevoke() {
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState('')
  return (
    <section className="sec">
      <h2>Couper les liens d’un numéro</h2>
      <p className="muted">À utiliser quand un lien a été transmis à la mauvaise personne. Tous les liens encore valides envoyés à ce numéro cessent de fonctionner ; de nouveaux liens peuvent être renvoyés depuis l’application.</p>
      <div className="card adm-form">
        <Field label="Numéro avec indicatif" id="adm-revoke-phone"><input id="adm-revoke-phone" type="tel" placeholder="+212…" value={phone} onChange={e => setPhone(e.target.value)} /></Field>
        <Field label="Motif (obligatoire)" id="adm-revoke-reason"><input id="adm-revoke-reason" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <ActionButton label="Couper les liens" confirm tone="bad" disabled={!phone.trim() || !reason.trim()}
          run={async () => setDone(`${(await api('/admin/links/revoke', { body: { phone: phone.trim(), reason } })).revoked} lien(s) coupé(s).`)} />
        {done && <p className="info" role="status">{done}</p>}
      </div>
    </section>
  )
}

const EXPORT_SETS = [['users', 'Comptes'], ['recorded_payments', 'Paiements signalés'], ['ledger', 'Grand livre'], ['disputes', 'Litiges'], ['audit', 'Journal d’audit']]
function Exports() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const get = set => download(`/admin/export/${set}?${new URLSearchParams({ ...(from && { from }), ...(to && { to }) })}`, `nexus-${set}.csv`).then(() => setError(''), e => setError(e.message))
  return (
    <section className="sec">
      <h2>Exports CSV</h2>
      <p className="muted">Pour la comptabilité, un partenaire ou une autorité. Sans dates, tout l’historique. Chaque export est inscrit au journal d’audit.</p>
      <div className="card adm-form">
        <div className="adm-search-row">
          <Field label="Du" id="adm-exp-from"><input id="adm-exp-from" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="Au (inclus)" id="adm-exp-to"><input id="adm-exp-to" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <div className="adm-search-row">{EXPORT_SETS.map(([set, label]) => <button key={set} className="chip-btn" onClick={() => get(set)}>{label}</button>)}</div>
        <Err msg={error} />
      </div>
    </section>
  )
}

function Ops() {
  const jobs = useLoad('/admin/outbox?status=failed')
  const [who, setWho] = useState('')
  const [action, setAction] = useState('')
  const [filter, setFilter] = useState({ who: '', action: '' })
  const audit = useLoad(`/admin/audit?${new URLSearchParams(filter)}`, [filter.who, filter.action])
  return (
    <>
      <section className="sec">
        <h2>Tâches externes en échec</h2>
        <Err msg={jobs.error} />
        <div className="card">
          {jobs.data?.jobs.length === 0 && <div className="row muted">Aucune tâche en échec.</div>}
          {jobs.data?.jobs.map(j => (
            <div key={j.id} className="row"><div className="row-main">
              <div className="grow"><div className="row-title">{j.kind} · n° {j.id}</div><div className="muted">{j.attempts} essais · {j.last_error}</div></div>
              <ActionButton label="Relancer" run={() => api(`/admin/outbox/${j.id}/retry`, { body: {} })} onDone={jobs.reload} />
            </div></div>
          ))}
        </div>
      </section>
      <LinkRevoke />
      <Exports />
      <section className="sec">
        <h2>Journal d’audit</h2>
        <form className="adm-search-row" onSubmit={e => { e.preventDefault(); setFilter({ who, action }) }}>
          <input aria-label="Identifiant d’utilisateur ou d’objet" placeholder="Identifiant" value={who} onChange={e => setWho(e.target.value)} />
          <input aria-label="Action" placeholder="Action (ex. dispute)" value={action} onChange={e => setAction(e.target.value)} />
          <button className="chip-btn primary">Filtrer</button>
        </form>
        <Err msg={audit.error} />
        <div className="card adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>Date</th><th>Acteur</th><th>Action</th><th>Objet</th></tr></thead>
            <tbody>{audit.data?.events.map(e => <tr key={e.id}><td>{when(e.created_at)}</td><td>{e.actor_type}</td><td>{e.action}</td><td>{e.object_type ?? ''} {e.object_id ? String(e.object_id).slice(0, 8) : ''}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </>
  )
}

const VIEWS = { overview: Overview, pilot: Pilot, users: Users, disputes: Disputes, adjustments: Adjustments, ops: Ops }

export default function AdminConsole({ onClose }) {
  const [tab, setTab] = useState('overview')
  const View = VIEWS[tab]
  return (
    <div className="adm" role="dialog" aria-modal="true" aria-label="Administration">
      <header className="adm-head">
        <h1 className="screen-title">Administration</h1>
        <button className="ibtn" onClick={onClose} aria-label="Fermer l’administration"><Icon name="x" /></button>
      </header>
      <nav className="adm-tabs" aria-label="Sections">
        {TABS.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      <div className="adm-body"><View key={tab} /></div>
    </div>
  )
}
