// Browser tests of the built app, on a phone-sized screen, against a freshly seeded sandbox database.
//   npm run build && npm run e2e
// Uses the database in E2E_DATABASE_URL (default: local nexus_e2e), which is WIPED at start.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import pg from 'pg'
import { chromium } from 'playwright'

const PORT = 3190, ORIGIN = `http://localhost:${PORT}`
const DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://nexus:nexus@localhost:5432/nexus_e2e'
const env = { ...process.env, NEXUS_ENV: 'sandbox', PORT: String(PORT), DATABASE_URL, NEXUS_NO_AUTO_SETTLE: '' }
const PRELOADED = '/opt/pw-browsers/chromium' // present in some build machines; elsewhere Playwright finds its own browser

let server, browser, seedLog = ''
before(async () => {
  assert.ok(fs.existsSync(new URL('../dist/index.html', import.meta.url)), 'build the interface first: npm run build')
  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect(); await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await db.end()
  seedLog = execFileSync(process.execPath, ['server/seed.js'], { env, encoding: 'utf8' })
  server = spawn(process.execPath, ['server/index.js'], { env, stdio: 'ignore' })
  for (let i = 0; ; i++) {
    if (await fetch(`${ORIGIN}/api/health`).then(r => r.ok, () => false)) break
    assert.ok(i < 100, 'the server did not start')
    await new Promise(r => setTimeout(r, 100))
  }
  browser = await chromium.launch(fs.existsSync(PRELOADED) ? { executablePath: PRELOADED } : {})
})
after(async () => { await browser?.close(); server?.kill() })

const phonePage = async () => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' })).newPage()
  page.setDefaultTimeout(10_000)
  return page
}
const typePin = async (page, pin) => { for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click() }
const useShownCode = page => page.locator('p.info button.link').click()

test('a new person signs up: code, profile, consent, secret code, then lands on their home screen', async () => {
  const page = await phonePage()
  await page.goto(ORIGIN)
  await page.getByLabel('Indicatif du pays').selectOption('+224')
  await page.locator('#auth-number').fill('620 55 44 33')
  await page.getByRole('button', { name: 'Recevoir le code' }).click()
  await useShownCode(page)
  await page.getByRole('button', { name: 'Valider' }).click()

  await page.getByRole('heading', { name: /Que faites-vous en Guinée/ }).waitFor()
  await page.locator('button.option').first().click()
  await page.getByLabel('Prénom et nom').fill('Aïcha Barry')
  const next = page.getByRole('button', { name: 'Continuer' })
  assert.equal(await next.isDisabled(), true, 'no account without accepting the terms')
  await page.getByRole('checkbox').check()
  await next.click()

  await typePin(page, '4826'); await page.getByRole('heading', { name: 'Confirmez votre code' }).waitFor(); await typePin(page, '4826')
  await page.locator('.auth').waitFor({ state: 'detached' })
  await page.getByText('Aïcha Barry').first().waitFor()
})

test('a returning person signs in with their secret code and sees their activity', async () => {
  const page = await phonePage()
  await page.goto(ORIGIN)
  await page.getByText('Hassan Benali').click()
  await useShownCode(page)
  await page.getByRole('button', { name: 'Valider' }).click()
  await page.getByRole('heading', { name: 'Bonjour Hassan' }).waitFor()
  await typePin(page, '1111')
  await page.getByRole('alert').waitFor() // a wrong code is refused, in words
  await typePin(page, '2580')
  await page.locator('.auth').waitFor({ state: 'detached' })
  await page.getByText('Hassan Benali').first().waitFor()
})

test('someone without the app opens a link, confirms with a code sent to their phone, and sees the result', async () => {
  // The seed "sends" this link to a client in Guinea: it is written to the log instead of WhatsApp.
  const token = seedLog.split('\n').find(l => l.includes('Payez-le directement'))?.match(/\/l\/([\w-]+)/)?.[1]
  assert.ok(token, 'the seed created a payment-request link')
  const page = await phonePage()
  await page.goto(`${ORIGIN}/l/${token}`)
  await page.getByText('Vous n’avez pas besoin d’installer d’application').waitFor()
  await page.getByRole('button', { name: 'J’ai payé' }).click()
  await page.getByRole('button', { name: 'Recevoir le code' }).click()
  await useShownCode(page)
  await page.getByRole('button', { name: /Confirmer : J’ai payé/ }).click()
  await page.getByText('Paiement signalé. Le bénéficiaire doit confirmer.').waitFor()
  await page.getByText('Paiement signalé', { exact: true }).waitFor() // the page now shows the new status
})

test('the terms page is readable without an account', async () => {
  const page = await phonePage()
  await page.goto(`${ORIGIN}/legal.html`)
  await page.getByRole('heading', { name: 'Conditions d’utilisation et confidentialité' }).waitFor()
})
