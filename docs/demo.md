# Online demo

A public copy of the **sandbox** to show Nexus to partners and investors: the 39 demo accounts, one per profile and country (PIN `2580`), the simulated payment partner, login codes shown on screen. It is not the pilot: for real people, follow [pilot.md](pilot.md).

## Deploy on Render

1. Sign in at [render.com](https://render.com) with the GitHub account that owns this repository.
2. **New → Blueprint**, pick the repository and the branch. Render reads [`render.yaml`](../render.yaml) and creates:
   - `nexus-demo`: the app, built from the `Dockerfile`, with `NEXUS_ENV=sandbox` and generated `JWT_SECRET` / `LINK_SECRET`;
   - `nexus-demo-db`: a PostgreSQL database.
3. Wait for the first deploy. On start the container runs `server/seed.js` (migrations, then the demo accounts once), then the server.
4. Open the address Render shows (`https://nexus-demo-….onrender.com`). Links sent from the app use it automatically (`RENDER_EXTERNAL_URL`).

## What to know

- **Free plan.** The app sleeps after about 15 minutes without visits; the first visit then takes up to a minute. Render's free PostgreSQL is deleted after 30 days: upgrade it, or recreate it and redeploy (the seed runs again on an empty database).
- **Reset the demo.** The **Recommencer la démo** button at the bottom of the sign-in screen puts everything back as seeded, in a few seconds. Anyone with the address can press it: to hide it, add `SANDBOX_RESET=off` to the service's environment.
- **Photos** are stored on the container's disk and disappear at each deploy. Fine for a demo.
- **Anyone with the address can sign in** to every demo account: the sign-in screen lists them. Share the link, not the data.
