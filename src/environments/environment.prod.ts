export const environment = {
  production: true,
  tmdbApiKey: 'c646ab9e5209d5c5c8d42ab3f653b61a',
  /** Default / #1 — failover: ApiPlayer → VidFast → lowest-ping others. */
  streamProvider: 'apiplayer' as
    | 'apiplayer'
    | 'vidfast'
    | 'cinemaos'
    | 'vidphantom'
    | 'peachify'
    | 'vidup'
    | 'videasy',
  streamProviders: [
    'apiplayer',
    'vidfast',
    'cinemaos',
    'vidphantom',
    'peachify',
    'vidup',
    'videasy',
  ] as Array<
    | 'apiplayer'
    | 'vidfast'
    | 'cinemaos'
    | 'vidphantom'
    | 'peachify'
    | 'vidup'
    | 'videasy'
  >,
  streamServer: 'vEdge',
  streamServers: ['vEdge', 'Beta', 'Bravo', 'vFast', 'Cobra', 'Charlie'],
  /** Prefer OPENROUTER_API_KEY on the auth API — do not commit secrets here. */
  openRouterApiKey: '',
  openRouterModel: 'google/gemma-4-31b-it:free',
  /** Auth API on Render (Root Directory: auth-api) */
  authApiUrl: 'https://luscreens.onrender.com',
};
