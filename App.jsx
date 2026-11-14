import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, session } from './api.js'
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

function Services({ openAdmin }) {
  const { me, setTab, logout } = useApp()
  const { user, experience } = me
  return (
    <div className="screen">
      <h1 className="screen-title">Services</h1>
      <p className="muted">Disponibles en {experience.region.name} · {experience.region.custody === 'held' ? 'avec partenaire de paiement agréé' : 'paiements en direct, preuves dans Nexus'}</p>
      <div className="tiles">
        {experience.services.map(m => <button key={m.id} className="tile" onClick={() => setTab(m.id)}><span className="disc soft"><Icon name={m.icon} /></span>{m.label}</button>)}
      </div>
      {user.pendingRoles.length > 0 && <div className="insight notice"><Icon name="clock" size={22} /><div><p>Votre demande d’agrément est en cours de vérification par notre équipe.</p></div></div>}
      <div className="card account">
        <div><strong>{user.name}</strong><div className="muted">{user.phone} · {KYC[user.kycLevel]}</div></div>
        <button className="chip-btn" onClick={logout}><Icon name="log-out" size={16} />Se déconnecter</button>
      </div>
      {user.isAdmin && <button className="cta quiet" onClick={openAdmin}><Icon name="shield-check" size={18} /> Console d’administration</button>}
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
  useEffect(() => { if (signedIn) api('/me').then(setMe).catch(() => setSignedIn(false)) }, [signedIn, version])

  if (signedIn === null) return <div className="boot"><Icon name="loader-circle" size={28} /></div>
  if (!signedIn) return <Auth onDone={() => setSignedIn(true)} />
  if (!me) return <div className="boot"><Icon name="loader-circle" size={28} /></div>

  const { experience, user } = me
  const ctx = { me, version, tab, setTab, logout, openAction: (module, action, row = null) => setSheet({ module, action, row }) }
  const current = experience.nav.some(m => m.id === tab) ? tab : 'services'
  const homeHead = (
    <header className="head">
      <span className="disc soft"><Icon name={experience.persona.icon} /></span>
      <div className="grow"><strong>{user.name}</strong><div className="muted">{experience.persona.label} · {experience.region.name}</div></div>
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
