export const environment = {
  production: false,
  tmdbApiKey: 'c646ab9e5209d5c5c8d42ab3f653b61a',
  streamServer: 'vEdge',
  /** VidFast `server=` query values shown in the custom Server picker */
  streamServers: ['vEdge', 'Beta', 'Bravo', 'vFast', 'Cobra', 'Charlie'],
  /**
   * Prefer setting OPENROUTER_API_KEY on the auth API (Render) instead of here.
   * Client key is only a local/dev fallback.
   */
  openRouterApiKey: '',
  openRouterModel: 'openrouter/free',
  /** Auth API on Render (Root Directory: auth-api) */
  authApiUrl: 'https://luscreens.onrender.com',
};
  