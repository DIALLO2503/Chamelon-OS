import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { t, LANGS, currentLang, setLang } from './i18n.js'
import { api, session, download } from './api.js'
import Auth from './Auth.jsx'
import Icon from './ui/Icon.jsx'
import Block from './ui/Blocks.jsx'
import ActionSheet from './ui/ActionSheet.jsx'
import PublicPage from './public/PublicPage.jsx'
import AdminConsole from './admin/AdminConsole.jsx'

const AppCtx = createContext(null)
export const useApp = () => useContext(AppCtx)

// Fetches a server-built screen and refetches whenever an action changes something; old data stays visible meanwhile.
function useScreen(path) {
  const { version } = useApp()
  const [state, setState] = useState({ path, data: null, error: null })
  useEffect(() => {
    let live = true
    api(path).then(data => live && setState({ path, data, error: null })).catch(e => live && setState(s => ({ ...s, path, error: e.message })))
    return () => { live = false }
  }, [path, version])
  return state.path === path ? state : { data: null, error: null }
}

function Screen({ path, head }) {
  const { data, error } = useScreen(path)
  const { openAction } = useApp()
  if (error && !data) return <div className="screen">{head}<p className="error" role="alert">{error}</p></div>
  if (!data) return <div className="screen" aria-busy="true">{head}{[72, 88, 180, 140].map(h => <div key={h} className="skeleton" style={{ height: h }} />)}</div>
  return (
    <div className="screen">
      {data._offline && <div className="insight notice" role="status"><Icon name="clock" size={22} /><div><p>Hors ligne · dernière mise à jour {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(data._offline))}. Lecture seule : les actions reviennent avec le réseau.</p></div></div>}
      {head ?? <h1 className="screen-title">{data.label}</h1>}
      {data.actions?.length > 0 && (
        <div className="chip-row">
          {data.actions.map((a, i) => <button key={a.id} className={`chip-btn ${i === 0 ? 'primary' : ''}`} onClick={() => openAction(data.id, a.id)}><Icon name={a.icon} size={16} />{a.label}</button>)}
        </div>
      )}
      {data.blocks.map((b, i) => <Block key={i} block={b} />)}
    </div>
  )
}

const KYC = ['Numéro vérifié', 'Identité vérifiée', 'Vérification renforcée']

// The person's rights over their data: a copy to keep, and a request to close the account (handled by the team).
function DataRights() {
  const [state, setState] = useState({ busy: false, note: '', error: '', confirm: false })
  const run = fn => async () => {
    setState(s => ({ ...s, busy: true, error: '', note: '' }))
    try { setState({ busy: false, error: '', note: (await fn()) ?? '', confirm: false }) } catch (e) { setState({ busy: false, error: e.message, note: '', confirm: false }) }
  }
  return (
    <section className="sec">
      <h2>Vos données</h2>
      <div className="card account rights">
        <p className="muted">Vous pouvez garder une copie de tout ce que Nexus conserve sur vous, ou demander la fermeture de votre compte. <a href="/legal.html" target="_blank" rel="noopener">Conditions et confidentialité</a></p>
        <button className="chip-btn" disabled={state.busy} onClick={run(() => download('/me/export', 'mes-donnees-nexus.json').then(() => 'Fichier téléchargé.'))}><Icon name="download" size={16} />Télécharger mes données</button>
        {state.confirm
          ? <><button className="chip-btn" disabled={state.busy} onClick={run(async () => (await api('/me/closure', { body: {} })).message)}>Confirmer la demande</button><button className="chip-btn" onClick={() => setState(s => ({ ...s, confirm: false }))}>Annuler</button></>
          : <button className="chip-btn" disabled={state.busy} onClick={() => setState(s => ({ ...s, confirm: true, note: '', error: '' }))}>Demander la fermeture du compte</button>}
        {state.note && <p className="info" role="status">{state.note}</p>}
        {state.error && <p className="error" role="alert">{state.error}</p>}
      </div>
    </section>
  )
}

// The person's profile: the drift suggestion when their activity has outgrown it, and the profiles they may move to.
// A switch keeps every record, balance and reputation point; the server enforces consent, cooldown and restrictions.
function Profile() {
  const { me, refresh } = useApp()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState({ busy: '', error: '', confirm: '' })
  useEffect(() => { api('/me/personas').then(setData).catch(() => {}) }, [me.experience.persona.id])
  if (!data) return null
  const go = async to => {
    if (state.confirm !== to) return setState({ busy: '', error: '', confirm: to })
    setState({ busy: to, error: '', confirm: '' })
    try { await api('/me/persona', { body: { to } }); refresh() } catch (e) { setState({ busy: '', error: e.message, confirm: '' }) }
  }
  const list = open ? data.choices : data.choices.filter(c => c.suggested)
  return (
    <section className="sec">
      <h2>{t('Votre profil')}</h2>
      <div className="card">
        <div className="row"><div className="row-main"><span className="disc soft small"><Icon name={me.experience.persona.icon} size={16} /></span><div className="grow"><div className="row-title">{me.experience.persona.label}</div><div className="muted">Votre application est construite pour ce métier.</div></div></div></div>
        {data.suggestion && <div className="insight"><Icon name="sparkles" size={22} /><div><p>{data.suggestion.why} : votre activité ressemble à celle du profil « {data.suggestion.label} ».</p></div></div>}
        {list.map(c => (
          <div key={c.id} className="row"><div className="row-main">
            <span className="disc soft small"><Icon name={c.icon} size={16} /></span>
            <div className="grow"><div className="row-title">{c.label} {c.tier > 1 && <span className="pill">Tier {c.tier}</span>}</div><div className="muted">{c.tagline}</div></div>
            <button className={`chip-btn ${c.suggested ? 'primary' : ''}`} disabled={Boolean(data.cooldownUntil) || state.busy === c.id} onClick={() => go(c.id)}>{state.confirm === c.id ? t('Confirmer') : t('Passer à ce profil')}</button>
          </div></div>
        ))}
        {data.cooldownUntil && <div className="row muted">Prochain changement possible le {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(data.cooldownUntil))}.</div>}
        {data.choices.length > 0 && <button className="row row-main" onClick={() => setOpen(o => !o)}><div className="grow muted">{open ? 'Masquer les autres profils' : `Voir les autres profils (${data.choices.length})`}</div><Icon name={open ? 'chevron-left' : 'chevron-right'} size={16} /></button>}
      </div>
      {state.error && <p className="error" role="alert">{state.error}</p>}
      <p className="muted">Changer de profil garde vos paiements, vos soldes et votre réputation. Un changement tous les 30 jours au plus.</p>
    </section>
  )
}

// Language: saved on this device and on the account (the server then translates module names and quick actions).
function Language() {
  const { refresh } = useApp()
  const pick = async id => { setLang(id); await api('/me/locale', { body: { locale: id } }).catch(() => {}); refresh() }
  return (
    <section className="sec">
      <h2>{t('Langue')}</h2>
      <div className="chip-row">{LANGS.map(([id, name]) => <button key={id} className={`chip-btn ${currentLang() === id ? 'primary' : ''}`} aria-pressed={currentLang() === id} onClick={() => pick(id)}>{name}</button>)}</div>
    </section>
  )
}

function Services({ openAdmin }) {
  const { me, setTab, logout } = useApp()
  const { user, experience } = me
  return (
    <div className="screen">
      <h1 className="screen-title">{t('Services')}</h1>
      <p className="muted">Disponibles en {experience.region.name} · {experience.region.custody === 'held' ? 'avec partenaire de paiement agréé' : 'paiements en direct, preuves dans Nexus'}</p>
      <div className="tiles">
        {experience.services.map(m => <button key={m.id} className="tile" onClick={() => setTab(m.id)}><span className="disc soft"><Icon name={m.icon} /></span>{m.label}</button>)}
      </div>
      {experience.locked?.length > 0 && (
        <section className="sec">
          <h2>{t('À débloquer')}</h2>
          <div className="card">
            {experience.locked.map(m => (
              <button key={m.id} className="row row-main locked" onClick={() => setTab('score')}>
                <span className="disc soft small"><Icon name="lock" size={16} /></span>
                <div className="grow"><div className="row-title">{m.label}</div><div className="muted">Niveau {m.level} « {m.name} » · encore {m.pointsLeft} points</div></div>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
          </div>
          <p className="muted">Les services s’ouvrent au fur et à mesure que votre réputation grandit : chaque paiement confirmé, cotisation versée ou étape validée compte.</p>
        </section>
      )}
      <Profile />
      <Language />
      {user.pendingRoles.length > 0 && <div className="insight notice"><Icon name="clock" size={22} /><div><p>Votre demande d’agrément est en cours de vérification par notre équipe.</p></div></div>}
      <div className="card account">
        <div><strong>{user.name}</strong><div className="muted">{user.phone} · {KYC[user.kycLevel]}</div></div>
        <button className="chip-btn" onClick={logout}><Icon name={me.sandbox ? 'users-round' : 'log-out'} size={16} />{me.sandbox ? t('Changer de compte') : t('Se déconnecter')}</button>
      </div>
      <DataRights />
      {user.isAdmin && <button className="cta quiet" onClick={openAdmin}><Icon name="shield-check" size={18} /> {t('Console d’administration')}</button>}
    </div>
  )
}

function MainApp() {
  const [me, setMe] = useState(null)
  const [signedIn, setSignedIn] = useState(null)
  const [tab, setTab] = useState('home')
  const [sheet, setSheet] = useState(null)
  const [version, setVersion] = useState(0)
  const [admin, setAdmin] = useState(false)

  const logout = useCallback(async () => { await session.logout(); setMe(null); setSignedIn(false); setTab('home'); setSheet(null); setAdmin(false) }, [])
  useEffect(() => { session.onExpired(() => { setMe(null); setSignedIn(false) }) }, [])
  useEffect(() => { session.restore().then(setSignedIn) }, [])
  // Language at sign-in: a language picked on this device (before signing in) is saved to the account; otherwise the
  // account's language (chosen on another phone) is applied here. French is the default on both sides.
  useEffect(() => {
    if (!signedIn) return
    api('/me').then(m => {
      const device = currentLang(), account = m.user.locale ?? 'fr'
      if (device !== account) {
        if (account === 'fr') api('/me/locale', { body: { locale: device } }).then(() => setVersion(v => v + 1)).catch(() => {})
        else setLang(account)
      }
      setMe(m)
    }).catch(() => setSignedIn(false))
  }, [signedIn, version])

  if (signedIn === null) return <div className="boot"><Icon name="loader-circle" size={28} /></div>
  if (!signedIn) return <Auth onDone={() => setSignedIn(true)} />
  if (!me) return <div className="boot"><Icon name="loader-circle" size={28} /></div>

  const { experience, user } = me
  const ctx = { me, version, tab, setTab, logout, refresh: () => { setVersion(v => v + 1); setTab('home') }, openAction: (module, action, row = null) => setSheet({ module, action, row }) }
  const current = experience.nav.some(m => m.id === tab) ? tab : 'services'
  const homeHead = (
    <header className="head">
      <span className="disc soft"><Icon name={experience.persona.icon} /></span>
      <div className="grow"><strong>{user.name}</strong><div className="muted">{experience.persona.label} · {experience.region.name}</div></div>
      {me.sandbox && <button className="ibtn" aria-label="Changer de compte (bac à sable)" title="Changer de compte" onClick={logout}><Icon name="users-round" /></button>}
      <button className="ibtn bell" aria-label={`Messages${me.unread ? `, ${me.unread} non lus` : ''}`} onClick={() => setTab('inbox')}>
        <Icon name="bell" />{me.unread > 0 && <span className="badge">{me.unread > 9 ? '9+' : me.unread}</span>}
      </button>
    </header>
  )

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell" data-contrast={experience.persona.presentation.contrast} style={{ '--hue': experience.persona.hue, fontSize: `${(experience.persona.presentation.textScale ?? 1) * 100}%` }}>
        {tab === 'home' ? <Screen path="/home" head={homeHead} /> : tab === 'services' ? <Services openAdmin={() => setAdmin(true)} /> : <Screen key={tab} path={`/modules/${tab}`} />}
        <nav className="nav">
          {experience.nav.map(m => (
            <button key={m.id} aria-current={m.id === current ? 'page' : undefined} onClick={() => setTab(m.id)}><Icon name={m.icon} size={22} /><span>{m.label}</span></button>
          ))}
        </nav>
        {sheet && <ActionSheet {...sheet} onClose={changed => { setSheet(null); if (changed) setVersion(v => v + 1) }} onDone={() => setVersion(v => v + 1)} />}
        {admin && <AdminConsole onClose={() => setAdmin(false)} />}
      </div>
    </AppCtx.Provider>
  )
}

export default function App() {
  const link = window.location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/)
  return link ? <PublicPage token={link[1]} /> : <MainApp />
}
