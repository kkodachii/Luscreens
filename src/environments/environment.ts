export type StreamProvider =
  | 'apiplayer'
  | 'vidfast'
  | 'cinemaos'
  | 'vidphantom'
  | 'peachify'
  | 'vidup'
  | 'videasy'
  | 'movies111';

export const environment = {
  production: false,
  tmdbApiKey: 'c646ab9e5209d5c5c8d42ab3f653b61a',
  /** Default / #1 — failover: ApiPlayer → VidFast → lowest-ping others. */
  streamProvider: 'apiplayer' as StreamProvider,
  streamProviders: [
    'apiplayer',
    'vidfast',
    'cinemaos',
    'vidphantom',
    'peachify',
    'vidup',
    'videasy',
    'movies111',
  ] as StreamProvider[],
  streamServer: 'vEdge',
  /** VidFast `server=` query values shown in the custom Server picker */
  streamServers: ['vEdge', 'Beta', 'Bravo', 'vFast', 'Cobra', 'Charlie'],
  /**
   * Prefer setting OPENROUTER_API_KEY on the auth API (Render) instead of here.
   * Client key is only a local/dev fallback.
   */
  openRouterApiKey: '',
  openRouterModel: 'google/gemma-4-31b-it:free',
  /**
   * Local auth-api for web/dev. Render is Cloudflare-blocked for 111Movies
   * token fetch ("Just a moment..." / 403) — use: cd auth-api && npm start
   * Production builds use environment.prod.ts → luscreens.onrender.com
   */
  authApiUrl: 'http://127.0.0.1:8788',
};
