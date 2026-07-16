# Luscreens Auth API

Email/password authentication for Luscreens (JWT).  
Users + library are stored in **MongoDB** when `MONGODB_URI` is set (recommended for Render).

## Local

```bash
cd auth-api
npm install
```

### With MongoDB (recommended)

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Database Access → create a user
3. Network Access → allow `0.0.0.0/0` (or your IP)
4. Connect → Drivers → copy the URI, e.g.  
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/luscreens?retryWrites=true&w=majority`
5. Set env and start:

```bash
# Windows PowerShell
$env:MONGODB_URI="mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/luscreens?retryWrites=true&w=majority"
$env:JWT_SECRET="a-long-random-string"
npm start
```

### Without MongoDB (local only)

If `MONGODB_URI` is missing, data is saved under `data/*.json` (fine for local testing; **lost on Render redeploy**).

```bash
npm start
```

Health: `http://localhost:8788/health`

## Render

1. Connect this repo as a Web Service
2. **Root Directory:** `auth-api` (not an API path)
3. **Build:** `npm install`
4. **Start:** `npm start`
5. **Environment variables:**
   - `MONGODB_URI` = your Atlas connection string (**required** so accounts survive redeploy)
   - `JWT_SECRET` = a long random string
   - `ADMIN_EMAILS` = `kean@gmail.com` (optional; comma-separated)
6. Copy the service URL into Angular `authApiUrl` (e.g. `https://luscreens.onrender.com`)

### Atlas checklist

- Cluster created (free M0 is fine)
- DB user username/password
- Network Access includes Render (use `0.0.0.0/0` if unsure)
- URI database name set (e.g. `/luscreens` before `?`)

## Endpoints

- `GET /` — service info
- `GET /health` — health + storage mode (`mongodb` | `json-file`)
- `POST /auth/register` `{ email, password, name? }`
- `POST /auth/login` `{ email, password }`
- `GET /auth/me` `Authorization: Bearer <token>`
- `GET /auth/admin/users` — admin only
- `GET /me/library` — user history / watchlist
- `PUT /me/library` `{ progress, watchlist }`

## Notes

- With MongoDB, redeploys **keep** accounts and libraries.
- Without `MONGODB_URI` on Render, accounts are wiped on every deploy.
- First request after free Render sleep may take 30–60s.
- Existing JSON users are **not** auto-imported; register again after switching to MongoDB (or ask for a one-time import script).
