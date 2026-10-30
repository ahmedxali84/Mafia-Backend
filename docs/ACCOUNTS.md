# Turning on Google login and saved stats

Accounts are **off** until the settings below exist. While they are off, the site works exactly as
before: everyone plays as a guest and the Career page uses the stats kept in the browser.
How it works is described at the end of [EVENTS.md](EVENTS.md).

You need three things: a Google OAuth client, a MongoDB database and one shared secret.

## 1. Google OAuth client (for the frontend)

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: app name "Mafia", your support email, *External*.
   Add yourself and the team as test users while it is in testing mode.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
4. **Authorized redirect URIs**, add both:
   - `https://mafia-frontend-lyart.vercel.app/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google` (local development)
5. Copy the **Client ID** and **Client secret**.

## 2. MongoDB (for the backend)

1. Create a free cluster at <https://www.mongodb.com/atlas> (M0).
2. **Database Access**: add a user with a strong password (read and write to any database).
3. **Network Access**: allow `0.0.0.0/0` (Render's free plan has no fixed IP).
4. **Connect → Drivers**: copy the connection string, e.g.
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/`

The server creates the `mafia` database and its `users` collection by itself on the first game.

## 3. One shared secret

Generate it once and use the **same value** on Vercel and Render:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Where each value goes

| Setting | Vercel (mafia-frontend) | Render (mafia-backend) |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Client ID from step 1 | – |
| `GOOGLE_CLIENT_SECRET` | Client secret from step 1 | – |
| `NEXTAUTH_SECRET` | A second random secret (same command as step 3) | – |
| `NEXTAUTH_URL` | `https://mafia-frontend-lyart.vercel.app` | – |
| `GAME_TOKEN_SECRET` | The shared secret from step 3 | The **same** shared secret |
| `MONGODB_URI` | – | Connection string from step 2 |

Vercel: **Project → Settings → Environment Variables**, then redeploy.
Render: **mafia-backend → Environment**, then **Manual Deploy** (this service doesn't auto-deploy).

## 5. Check it

- `https://mafia-backend-z04f.onrender.com/health` shows `"accounts": true`.
  The Render log says `MongoDB connected: saving stats for signed-in players`.
- The Play screen shows **Sign in with Google** under your profile.
- After signing in and finishing a game, Career says **Saved to your Google account**.

Never commit any of these values; they only go in the Vercel and Render dashboards (or local
`.env` / `.env.local` files, which git ignores).
