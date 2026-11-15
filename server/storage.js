// Where photos live. Disk (UPLOAD_DIR) for a single server and the sandbox; any S3-compatible object store (AWS S3,
// Cloudflare R2, MinIO, Scaleway…) when STORAGE=s3, so photos survive container replacement and several servers share them.
// The uploads row stores a locator: an absolute file path, or s3://<bucket>/<key>.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

let s3client = null
async function s3() {
  if (s3client) return s3client
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3')
  const client = new S3Client({
    region: config.storage.region, endpoint: config.storage.endpoint || undefined, forcePathStyle: Boolean(config.storage.endpoint),
    credentials: { accessKeyId: config.storage.accessKeyId, secretAccessKey: config.storage.secretAccessKey },
  })
  s3client = { client, PutObjectCommand, GetObjectCommand }
  return s3client
}

export async function putImage(id, buffer) {
  if (config.storage.kind === 's3') {
    const { client, PutObjectCommand } = await s3()
    const key = `uploads/${id}.jpg`
    await client.send(new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, Body: buffer, ContentType: 'image/jpeg' }))
    return `s3://${config.storage.bucket}/${key}`
  }
  fs.mkdirSync(config.uploadDir, { recursive: true })
  const file = path.join(config.uploadDir, `${id}.jpg`)
  fs.writeFileSync(file, buffer)
  return file
}

// Sends the image whatever its store. Disk files are served relative to their directory: given a bare absolute path,
// Express refuses any path with a dot-segment (the default upload directory is .local/uploads).
export async function sendImage(res, upload) {
  res.type('image/jpeg').set('Cache-Control', 'private, max-age=3600')
  if (upload.path.startsWith('s3://')) {
    const [, bucket, ...rest] = upload.path.replace('s3://', '/').split('/')
    const { client, GetObjectCommand } = await s3()
    const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: rest.join('/') }))
    return res.send(Buffer.from(await obj.Body.transformToByteArray()))
  }
  return res.sendFile(path.basename(upload.path), { root: path.dirname(upload.path) })
}
