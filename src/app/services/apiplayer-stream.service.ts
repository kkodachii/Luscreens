import { Injectable } from '@angular/core';

export interface ApiplayerStreamInfo {
  masterUrl: string;
  imdbId: string | null;
  tmdbId: number | null;
  contentId: string | number | null;
}

interface ApiplayerEmbedConfig {
  vidsrcProxyUrl?: string | null;
  workerUrl?: string | null;
  fallbackUrl?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  contentId?: string | number | null;
}

/**
 * Resolves ApiPlayer HLS master URLs from their public embed page.
 * The live embed does not accept inbound postMessage control, so we play
 * the proxied HLS feed in our own <video> with the Luscreens controller.
 */
@Injectable({ providedIn: 'root' })
export class ApiplayerStreamService {
  private readonly embedOrigin = 'https://apiplayer.ru';

  async resolveStream(options: {
    mediaType: 'movie' | 'tv';
    id: string;
    season?: number;
    episode?: number;
  }): Promise<ApiplayerStreamInfo> {
    const { mediaType, id, season, episode } = options;
    const path =
      mediaType === 'tv' && season != null && episode != null
        ? `/embed/tv/${id}/${season}/${episode}`
        : `/embed/${mediaType}/${id}`;

    const url = `${this.embedOrigin}${path}?autoplay=0&resume=0`;
    const response = await fetch(url, {
      credentials: 'omit',
      headers: { Accept: 'text/html' },
    });

    if (!response.ok) {
      throw new Error(`ApiPlayer embed failed (${response.status})`);
    }

    const html = await response.text();
    const config = this.parseMplayerConfig(html);
    const proxyPath = config.vidsrcProxyUrl || config.workerUrl || config.fallbackUrl;
    if (!proxyPath || typeof proxyPath !== 'string') {
      throw new Error('ApiPlayer returned no stream URL');
    }

    return {
      masterUrl: new URL(proxyPath, this.embedOrigin).href,
      imdbId: typeof config.imdbId === 'string' ? config.imdbId : null,
      tmdbId: typeof config.tmdbId === 'number' ? config.tmdbId : null,
      contentId: config.contentId ?? null,
    };
  }

  private parseMplayerConfig(html: string): ApiplayerEmbedConfig {
    const marker = 'window.__MPLAYER__ = ';
    const start = html.indexOf(marker);
    if (start < 0) {
      throw new Error('ApiPlayer config not found');
    }

    const jsonStart = start + marker.length;
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < html.length; i++) {
      const ch = html[i];
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end < 0) {
      throw new Error('ApiPlayer config is malformed');
    }

    return JSON.parse(html.slice(jsonStart, end)) as ApiplayerEmbedConfig;
  }
}
