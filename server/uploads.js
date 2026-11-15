import express, { Router } from 'express'
import sharp from 'sharp'
import { pool, one } from './db.js'
import { config } from './config.js'
import { fail, newId, sha256 } from './core.js'
import { resolveLink } from './rails.js'
import { putImage, sendImage } from './storage.js'

// A public link may upload at most this many photos a day: enough for a job stage and dispute evidence, not a free file host.
const LINK_UPLOADS_PER_DAY = 12
const raw = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'], limit: '6mb' })

// Re-encodes to JPEG: strips EXIF (GPS, device), normalises orientation, caps the size. Position and time come from the
// app (captured at upload), stored as data, not inside the file.
export async function saveImage(body, { ownerType, ownerId, lat, lng }) {
  if (!Buffer.isBuffer(body) || !body.length) fail('Image manquante')
  let out
  try { out = await sharp(body).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer() } catch { fail('Image illisible') }
  const id = newId(), file = await putImage(id, out)
  const meta = { capturedAt: new Date().toISOString(), ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}) }
  await pool.query('INSERT INTO uploads (id, owner_type, owner_id, path, mime, size, sha256, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, ownerType, ownerId, file, 'image/jpeg', out.length, sha256(out.toString('base64')), meta])
  return { id, meta }
}


const num = v => (v === undefined ? NaN : Number(v))

// An upload is visible to its uploader, to admins, and to both parties of the job stage or dispute it belongs to.
async function canSee(userId, uploadId) {
  const u = await one(pool, 'SELECT * FROM uploads WHERE id=$1', [uploadId])
  if (!u) return null
  if (u.owner_type === 'user' && u.owner_id === userId) return u
  if (await one(pool, `SELECT 1 FROM roles WHERE user_id=$1 AND role='admin' AND status='active'`, [userId])) return u
  const party = await one(pool, 'SELECT id FROM parties WHERE user_id=$1', [userId])
  const inJob = party && await one(pool, `SELECT 1 FROM job_stages s JOIN jobs j ON j.id=s.job_id WHERE $1 = ANY(s.proof) AND (j.artisan_party=$2 OR j.client_party=$2)`, [uploadId, party.id])
  const inDispute = party && await one(pool, `SELECT 1 FROM dispute_evidence d JOIN disputes x ON x.id=d.dispute_id JOIN escrows e ON e.id=x.escrow_id WHERE d.upload_id=$1 AND (e.payer_party=$2 OR e.payee_party=$2)`, [uploadId, party.id])
  return inJob || inDispute ? u : null
}

export const uploadRoutes = Router()
uploadRoutes.post('/', raw, async (req, res) => res.json(await saveImage(req.body, { ownerType: 'user', ownerId: req.userId, lat: num(req.query.lat), lng: num(req.query.lng) })))
uploadRoutes.get('/:id', async (req, res) => {
  const u = await canSee(req.userId, req.params.id)
  if (!u) fail('Introuvable', 404)
  await sendImage(res, u)
})

// Uploads from a public link (an artisan without the app sending a site photo, or either side adding dispute evidence).
export const publicUploadRoutes = Router()
publicUploadRoutes.post('/:token/upload', raw, async (req, res) => {
  const link = await resolveLink(pool, req.params.token)
  if (!['job', 'escrow', 'order'].includes(link.kind)) fail('Envoi de photo indisponible pour ce lien', 400)
  const today = await one(pool, `SELECT count(*)::int AS n FROM uploads WHERE owner_type='link' AND owner_id=$1 AND created_at > now() - interval '1 day'`, [link.id])
  if (today.n >= LINK_UPLOADS_PER_DAY) fail('Trop de photos envoyées depuis ce lien aujourd’hui. Réessayez demain.', 429)
  res.json(await saveImage(req.body, { ownerType: 'link', ownerId: link.id, lat: num(req.query.lat), lng: num(req.query.lng) }))
})
publicUploadRoutes.get('/:token/uploads/:id', async (req, res) => {
  const link = await resolveLink(pool, req.params.token)
  const u = link.kind === 'job' && await one(pool, `SELECT up.* FROM uploads up JOIN job_stages s ON up.id = ANY(s.proof) WHERE up.id=$1 AND s.job_id=$2`, [req.params.id, link.ref_id])
  if (!u) fail('Introuvable', 404)
  await sendImage(res, u)
})
