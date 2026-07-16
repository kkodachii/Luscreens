# Luscreens Auth API

Email/password authentication for Luscreens (JWT).

## Local

```bash
cd auth-api
npm install
npm start
```

Health: `http://localhost:8788/health`

## Render

1. Connect this repo as a Web Service
2. **Root Directory:** `auth-api`
3. **Build:** `npm install`
4. **Start:** `npm start`
5. **Env vars (recommended):**
   - `JWT_SECRET` = a long random string
6. Copy the service URL into Angular `authApiUrl`

### Endpoints

- `POST /auth/register` `{ email, password, name? }`
- `POST /auth/login` `{ email, password }`
- `GET /auth/me` `Authorization: Bearer <token>`

### Notes

- Free Render disks are ephemeral — user accounts in `data/users.json` can be lost on redeploy. Fine for MVP; use a real DB later.
- First request after sleep may take 30–60s.
