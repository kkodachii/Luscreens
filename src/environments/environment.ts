export type StreamProvider = 'apiplayer' | 'cinemaos' | 'vidphantom' | 'vidfast';

export const environment = {
  production: false,
  tmdbApiKey: 'c646ab9e5209d5c5c8d42ab3f653b61a',
  /** Active embed host — controllers adapt via postMessage / HLS per provider */
  streamProvider: 'apiplayer' as StreamProvider,
  streamProviders: ['apiplayer', 'cinemaos', 'vidphantom', 'vidfast'] as StreamProvider[],
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
