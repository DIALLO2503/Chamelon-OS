# Running the pilot: Morocco and Guinea, without a payment partner

Both countries are in `record` custody: people pay each other directly and Nexus records, confirms and keeps the proof. No money passes through Nexus, so the pilot needs no licence and no payment partner. It needs three things: a server, a domain name, and one Android phone per country to send SMS.

Related: [operations.md](operations.md), [custody-stages.md](custody-stages.md), [security.md](security.md).

## What it costs

| Item | Cost |
|---|---|
| Software (Nexus, PostgreSQL, Caddy, SMS Gateway for Android) | Free, open source |
| Server | A small virtual machine: 2 GB of memory is enough |
| Domain name | A few euros a year; HTTPS certificates are free and automatic |
| SMS | The price of each SIM's plan; no per-message fee to a provider |
| Two Android phones (5.0 or later), kept plugged in and online | Hardware you may already own |

There is no SMS service that is both free and account-less: a mobile operator has to carry each message and someone pays it. The phone gateway moves that cost to an ordinary local SIM plan, which is the cheapest route for local numbers and needs no provider contract.

## 1. The phones

On each phone (one with a Moroccan SIM, one with a Guinean SIM):

1. Install **SMS Gateway for Android** (open source, Apache-2.0: `github.com/capcom6/android-sms-gateway`).
2. Turn on **Cloud Server**, tap **Start Service**, choose **Sign Up**. No email or personal information is asked.
3. Note the username and password shown under Cloud Server: they go in `SMSGATE_MA_*` or `SMSGATE_GN_*`.
4. Exclude the app from battery optimisation, and keep the phone charged and connected.

Limits to know:

- A code is "sent" for Nexus when the relay accepts it. If the phone is off, has no credit or no signal, the message waits and the person receives nothing: nobody can sign in from that country until it is back. Check the phones daily.
- Operators may block a SIM that sends many automated messages. This holds for a pilot of tens to a few hundred users, not beyond.
- Messages pass through the gateway project's relay server (`api.sms-gate.app`), which therefore sees phone numbers and login codes. The project documents end-to-end encryption and a self-hosted relay; neither is set up here.
- A phone on the same network as the server can be reached directly instead of through the relay: turn on the app's Local Server and set `SMSGATE_<ID>_URL=http://<phone address>:8080` with the local username and password. Its codes then never leave your network.
- WhatsApp is not automated in this setup. Users share their links through their own WhatsApp from the app's share button, which is free and needs nothing.

## 2. The server

Any provider's small Linux virtual machine works. One machine runs the app, the database and HTTPS, which keeps uploaded photos on a local disk and avoids the sleeping instances and expiring databases of free hosting tiers. Choose a European region: it is the closest well-connected location to both Morocco and Guinea.

1. Point the domain's DNS A record at the server.
2. Install Docker, clone this repository.
3. `cp deploy/.env.example deploy/.env` and fill it in (domain, database password, two secrets from `openssl rand -hex 48`, the phones' credentials).
4. Start:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The app refuses to start if the configuration is unsafe or incomplete, and says why: `docker compose -f deploy/docker-compose.yml logs app`.

`NEXUS_ENV=live` is not optional for real users. In `sandbox`, login codes are shown on screen and every account is listed publicly.

## 3. The first admins

Sign-up is open in Morocco and Guinea only (`SIGNUP_REGIONS=MA,GN`). An admin with a number from another country is created from the command line; disputes and adjustments need two different admins.

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec app node server/cli/create-admin.js +212600000000 "Prénom Nom"
```

The admin then signs in with their number, receives a login code, taps **Code secret oublié ?** and chooses a secret code. A number outside Morocco and Guinea receives its code only if a default phone is configured (`SMSGATE_USER`, `SMSGATE_PASSWORD`), at that SIM's international rate.

## 4. Backups

Everything lives in two Docker volumes: `db` (PostgreSQL) and `uploads` (photos). The `backup` service writes a database dump and a photo archive every night into a third volume, `backups`, and keeps 14 days (`deploy/backup.sh`).

Those backups sit on the same server, so they do not survive losing it. Copy them elsewhere regularly, for example to your own computer:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp backup:/backups ./nexus-backups
```

To restore a dump into an empty database:

```bash
gunzip -c nexus-backups/db-2026-11-15.sql.gz | docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db psql -U nexus nexus
```

The backup script was run against a local database and its dump restored with matching row counts; the `backup` container itself was not run.

## What to watch

Console → **Pilote** (`GET /api/admin/funnel?days=30`):

- **Accounts per country**: total, new in the period, active in the last 7 days.
- **Links sent**, per recipient country and per type: people invited, how many opened the link, how many acted on it, how many later opened an account. A link re-sent to the same person for the same job or order counts once.

The second table is the pilot's main result. The model assumes that someone who receives a link acts on it without installing anything, and that some of them then sign up. If few open, the problem is delivery or trust in the message; if many open and few act, it is the page.

Opening is counted when the page runs in a browser. The preview a messaging app draws for a shared link does not count: it reads the page without running it.

That preview shows the Nexus icon and one line saying what the link is ("Votre chantier : suivez et validez chaque étape"), never a name or an amount.

## Before real users

- **Personal data.** The server will hold names and phone numbers of people in Morocco and Guinea. Morocco's data-protection law (09-08, regulator CNDP) and Guinea's equivalent regulate collecting this data and storing it abroad. Get advice before onboarding people beyond a closed test group.
- **Not verified here.** The gateway adapter is tested against a local stand-in, not a real phone. The Docker image was built and started in `live` mode with this configuration; the full `docker compose` stack with Caddy and a real domain was not run.
- **Moving to a partner later.** Nothing here is thrown away: set `CUSTODY_<ID>=held` for the country, `PAYMENT_PROVIDER=partner` and the `PARTNER_*` variables ([partner-integration.md](partner-integration.md)).
