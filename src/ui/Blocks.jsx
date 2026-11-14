import { useEffect, useState } from 'react'
import { useApp } from '../App.jsx'
import { imageUrl } from '../api.js'
import Icon from './Icon.jsx'
import QRCode from 'qrcode'

// A short buzz when something is confirmed, so the phone gives the feel of money changing hands.
export const thud = () => { try { navigator.vibrate?.(300) } catch {} }

const Section = ({ title, children }) => <section className="sec">{title && <h2>{title}</h2>}{children}</section>

export function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }).catch(() => {})
  return <button className="chip-btn" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copié' : (label ?? 'Copier')}</button>
}

// Face to face: the other person scans the code with their phone camera and confirms on the spot, no app needed.
function ScanCode({ url }) {
  const [src, setSrc] = useState('')
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 440, errorCorrectionLevel: 'M' }).then(setSrc).catch(() => {}) }, [url])
  return src ? <figure className="qr"><img src={src} alt="Code à scanner" /><figcaption>La personne est avec vous ? Elle scanne ce code avec l’appareil photo de son téléphone.</figcaption></figure> : null
}

// WhatsApp first (that is where these users live), a code to scan when the person is present, then the phone's own share sheet.
export function ShareButtons({ share }) {
  const [scan, setScan] = useState(false)
  const native = typeof navigator !== 'undefined' && navigator.share
  return (
    <div className="share">
      <a className="cta whatsapp" href={share.whatsapp} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={20} /> Envoyer sur WhatsApp</a>
      {scan && <ScanCode url={share.url} />}
      <div className="share-row">
        <button className="chip-btn" aria-pressed={scan} onClick={() => setScan(v => !v)}><Icon name="qr-code" size={16} />{scan ? 'Masquer le code' : 'Faire scanner'}</button>
        {native && <button className="chip-btn" onClick={() => navigator.share({ text: share.text }).catch(() => {})}><Icon name="share" size={16} />Partager</button>}
        <CopyButton text={share.url} label="Copier le lien" />
      </div>
    </div>
  )
}

function Thumbs({ ids }) {
  const [urls, setUrls] = useState([])
  useEffect(() => {
    let live = true
    Promise.all(ids.map(id => imageUrl(id).catch(() => null))).then(u => live && setUrls(u.filter(Boolean)))
    return () => { live = false }
  }, [ids.join(',')])
  if (!urls.length) return null
  return <div className="thumbs">{urls.map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Photo du chantier" /></a>)}</div>
}

function Balance({ block }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('nexus_hide') === '1' } catch { return false } })
  const toggle = () => setHidden(h => { try { localStorage.setItem('nexus_hide', h ? '0' : '1') } catch {} return !h })
  return (
    <section className="bal">
      <div className="muted">{block.caption}</div>
      <div className="bal-row">
        <span className="bal-amount num">{hidden ? '••••••' : block.amount}</span>
        <button className="ibtn" onClick={toggle} aria-label={hidden ? 'Afficher le montant' : 'Masquer le montant'}><Icon name={hidden ? 'eye-off' : 'eye'} /></button>
      </div>
      {block.sub && <div className="muted">{block.sub}</div>}
    </section>
  )
}

function Actions({ block }) {
  const { openAction, setTab } = useApp()
  return (
    <div className="acts">
      {block.items.map((a, i) => (
        <button key={a.id} onClick={() => (a.opens ? setTab(a.opens) : openAction(a.module, a.action))}>
          <span className={`disc ${i === 0 ? '' : 'soft'}`}><Icon name={a.icon} size={22} /></span><span>{a.label}</span>
        </button>
      ))}
    </div>
  )
}

function Insight({ block }) {
  const { openAction, setTab } = useApp()
  const { cta } = block
  return (
    <div className={`insight ${block.type === 'notice' ? 'notice' : ''}`}>
      <Icon name={block.icon} size={22} />
      <div>
        <p>{block.text}</p>
        {cta && <button onClick={() => (cta.action ? openAction(cta.module, cta.action, cta.row) : setTab(cta.module))}>{cta.label}<Icon name="chevron-right" size={16} /></button>}
      </div>
    </div>
  )
}

const Kpis = ({ block }) => (
  <Section title={block.title}>
    <div className="kpis">{block.items.map(k => <div key={k.label} className="kpi"><span className="muted">{k.label}</span><b className={`num ${k.tone ?? ''}`}>{k.value}</b></div>)}</div>
  </Section>
)

function Rows({ block }) {
  const { openAction } = useApp()
  return (
    <Section title={block.title}>
      {block.rows.length === 0 ? <div className="card empty">{block.empty}</div> : (
        <div className="card">
          {block.rows.map(r => (
            <div key={r.id} className="row">
              <div className="row-main">
                <span className="disc soft small"><Icon name={r.icon ?? block.icon} size={18} /></span>
                <div className="grow">
                  <div className="row-title">{r.title}</div>
                  {r.sub && <div className="muted">{r.sub}</div>}
                  {r.progress != null && <div className="bar"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>}
                </div>
                <div className="row-end">
                  {r.value && <div className="row-value num">{r.value}</div>}
                  {r.status && <span className={`pill ${r.tone ?? ''}`}>{r.status}</span>}
                </div>
              </div>
              {r.proof?.length > 0 && <Thumbs ids={r.proof} />}
              {r.actions?.length > 0 && (
                <div className="row-actions">
                  {r.actions.map(a => <button key={a.id} className={`chip-btn ${a.tone === 'primary' ? 'primary' : ''}`} onClick={() => openAction(block.module, a.id, r.id)}>{a.label}</button>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const Feed = ({ block }) => (
  <Section title={block.title}>
    {block.days.length === 0 && <div className="card empty">{block.empty}</div>}
    {block.days.map(d => (
      <div key={d.label} className="day">
        <div className="muted day-label">{d.label}</div>
        <div className="card">
          {d.items.map((it, i) => (
            <div key={i} className="row"><div className="row-main">
              <span className={`disc small ${it.positive ? 'in' : 'out'}`}><Icon name={it.icon} size={18} /></span>
              <div className="grow"><div className="row-title">{it.title}</div>{it.sub && <div className="muted">{it.sub}</div>}</div>
              <div className={`row-value num ${it.positive ? 'ok' : ''}`}>{it.value}</div>
            </div></div>
          ))}
        </div>
      </div>
    ))}
  </Section>
)

function Bars({ block }) {
  const max = Math.max(1, ...block.bars.map(b => b.value)), bw = 28, gap = 16, H = 96
  return (
    <Section title={block.title}>
      <div className="card chart">
        <svg viewBox={`0 0 ${block.bars.length * (bw + gap) - gap} ${H + 18}`} role="img" aria-label={block.title}>
          {block.bars.map((b, i) => {
            const h = Math.max(3, (b.value / max) * H)
            return <g key={i}><rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx="6" className={b.value ? 'on' : 'off'} /><text x={i * (bw + gap) + bw / 2} y={H + 14} textAnchor="middle">{b.label}</text></g>
          })}
        </svg>
        <div className="chart-total"><span className="muted">{block.caption}</span><span className="num">{block.total}</span></div>
      </div>
    </Section>
  )
}

const Budget = ({ block }) => (
  <Section title={block.title}>
    <div className="card">
      <div className="row"><div className="grow">
        <div className="row-title num">{block.left} restants</div>
        <div className="muted num">{block.detail}</div>
        <div className={`bar ${block.over ? 'over' : ''}`}><i style={{ width: `${Math.round(block.pct * 100)}%` }} /></div>
      </div></div>
      {block.cats.map(c => <div key={c.label} className="row"><div className="row-main"><div className="grow">{c.label}</div><div className="row-value num">{c.value}</div></div></div>)}
    </div>
  </Section>
)

const Score = ({ block }) => (
  <Section>
    <div className="card">
      <div className="score"><b className="num">{block.value}</b><div><div className="row-title">sur 1000</div><div className="muted">{block.note}</div></div></div>
      {block.signals.map(s => <div key={s.label} className="row"><div className="grow"><div>{s.label}</div><div className="bar"><i style={{ width: `${Math.round(s.pct * 100)}%` }} /></div></div></div>)}
    </div>
  </Section>
)

// The reputation mosaic: one tile per kept commitment, laid on a 6 × 6 zellij.
function Zellij({ block }) {
  const side = Math.round(Math.sqrt(block.total)), cell = 40
  return (
    <Section>
      <div className="card zellij">
        <svg viewBox={`0 0 ${side * cell} ${side * cell}`} role="img" aria-label={`${block.filled} pièces posées sur ${block.total}`}>
          {Array.from({ length: block.total }, (_, i) => {
            const x = (i % side) * cell + cell / 2, y = Math.floor(i / side) * cell + cell / 2, on = i < block.filled
            return <g key={i} transform={`translate(${x} ${y})`} className={on ? 'on' : 'off'}>
              <rect x="-13" y="-13" width="26" height="26" rx="2" /><rect x="-13" y="-13" width="26" height="26" rx="2" transform="rotate(45)" />
            </g>
          })}
        </svg>
        <div className="zellij-head"><div><div className="muted">Niveau {block.level}</div><b>{block.name}</b></div><div className="muted">{block.filled} / {block.total} pièces · {block.next}</div></div>
        {block.perks.map(p => <div key={p.label} className={`perk ${p.on ? 'on' : ''}`}><Icon name={p.on ? 'circle-check' : 'lock'} size={18} /><span><strong>{p.label}</strong> · {p.text}</span></div>)}
      </div>
    </Section>
  )
}

const Goal = ({ block }) => (
  <Section title={block.title}>
    <div className="card goal"><div className={`row-title num ${block.reached ? 'ok' : ''}`}>{block.main}</div><div className="muted num">{block.detail}</div><div className="bar thick"><i style={{ width: `${Math.round(block.pct * 100)}%` }} /></div></div>
  </Section>
)

const Note = ({ block }) => (
  <Section title={block.title}>
    <div className="card note"><div className="grow"><div className="muted">{block.text}</div>{block.copy && <div className="row-title num selectable">{block.copy}</div>}</div>{block.copy && <CopyButton text={block.copy} />}</div>
  </Section>
)

const TYPES = { balance: Balance, actions: Actions, insight: Insight, notice: Insight, kpis: Kpis, rows: Rows, feed: Feed, bars: Bars, budget: Budget, score: Score, note: Note, zellij: Zellij, goal: Goal }

export default function Block({ block }) {
  const Component = TYPES[block.type]
  return Component ? <Component block={block} /> : null
}
