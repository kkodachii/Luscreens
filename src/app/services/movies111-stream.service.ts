import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export interface Movies111StreamInfo {
  masterUrl: string;
  type: 'hls' | 'mp4' | string;
  quality: string | null;
  plug: string | null;
  imdbId: string | null;
  tmdbId: string | number | null;
}

/**
 * Resolves 111Movies streams via auth-api (server decrypts Vidlove plugs).
 * Played in Luscreens' local <video> — cross-origin iframes fail plug resolution.
 */
@Injectable({ providedIn: 'root' })
export class Movies111StreamService {
  private readonly apiBase = String(
    (environment as { authApiUrl?: string }).authApiUrl || ''
  ).replace(/\/$/, '');

  async resolveStream(options: {
    mediaType: 'movie' | 'tv';
    id: string;
    season?: number;
    episode?: number;
  }): Promise<Movies111StreamInfo> {
    if (!this.apiBase) {
      throw new Error('authApiUrl is not configured');
    }

    const params = new URLSearchParams({
      type: options.mediaType,
      id: options.id,
    });
    if (options.mediaType === 'tv') {
      params.set('season', String(options.season ?? 1));
      params.set('episode', String(options.episode ?? 1));
    }

    const response = await fetch(`${this.apiBase}/movies111/resolve?${params}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });

    const body = (await response.json().catch(() => null)) as
      | (Movies111StreamInfo & { ok?: boolean; error?: string })
      | null;

    if (!response.ok || !body?.masterUrl) {
      throw new Error(body?.error || `111Movies resolve failed (${response.status})`);
    }

    return {
      masterUrl: body.masterUrl,
      type: body.type || 'hls',
      quality: body.quality ?? null,
      plug: body.plug ?? null,
      imdbId: typeof body.imdbId === 'string' ? body.imdbId : null,
      tmdbId: body.tmdbId ?? null,
    };
  }
}
