export type StreamProvider =
  | 'apiplayer'
  | 'vidfast'
  | 'cinemaos'
  | 'vidphantom'
  | 'peachify'
  | 'vidup'
  | 'videasy';

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
  /** Auth API on Render (Root Directory: auth-api) */
  authApiUrl: 'https://luscreens.onrender.com',
};
