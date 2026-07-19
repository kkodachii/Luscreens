import { Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { environment } from '../../environments/environment';

export interface Movies111StreamInfo {
  masterUrl: string;
  type: 'hls' | 'mp4' | string;
  quality: string | null;
  plug: string | null;
  imdbId: string | null;
  tmdbId: string | number | null;
}

const STREAM_API = 'https://momlover.notyourtype.dad';
const UPSTREAM = 'https://player.vidlove.cc';
const GCM_KEY = 'Sn00pD0g#RESP_B4SE_K3y_2026!';
const PLUGS = ['fabric', 'moviebox', 'cline', 'zebra', 'self'] as const;

/**
 * Resolves 111Movies streams via auth-api, with a native-device fallback when
 * Render cannot reach the upstream token host.
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
    try {
      return await this.resolveViaAuthApi(options);
    } catch (serverErr) {
      if (Capacitor.isNativePlatform()) {
        try {
          return await this.resolveOnDevice(options);
        } catch (nativeErr) {
          throw nativeErr instanceof Error ? nativeErr : serverErr;
        }
      }
      throw serverErr;
    }
  }

  private async resolveViaAuthApi(options: {
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

  /** Device IP often works when Render's datacenter IP is blocked upstream. */
  private async resolveOnDevice(options: {
    mediaType: 'movie' | 'tv';
    id: string;
    season?: number;
    episode?: number;
  }): Promise<Movies111StreamInfo> {
    const tokenRes = await CapacitorHttp.post({
      url: `${STREAM_API}/auth/generate-token`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, */*',
        Origin: UPSTREAM,
        Referer: `${UPSTREAM}/`,
      },
      data: { clientData: {} },
    });
    const tokenBody = this.asObject(tokenRes.data);
    const token = typeof tokenBody?.['token'] === 'string' ? tokenBody['token'] : null;
    if (!token) {
      throw new Error(`Native token failed (${tokenRes.status})`);
    }

    const kind = options.mediaType === 'tv' ? 'tv' : 'movie';
    for (const plug of PLUGS) {
      const path =
        kind === 'tv'
          ? `/${plug}/tv/${options.id}/${options.season ?? 1}/${options.episode ?? 1}`
          : `/${plug}/movie/${options.id}`;

      const plugRes = await CapacitorHttp.get({
        url: `${STREAM_API}${path}`,
        headers: {
          Accept: 'application/json, */*',
          Origin: UPSTREAM,
          Referer: `${UPSTREAM}/`,
          'x-request-token': token,
          'x-response-encryption': 'aes-gcm',
        },
      });
      if (plugRes.status >= 400) {
        continue;
      }

      let data = this.asObject(plugRes.data);
      if (!data) {
        continue;
      }
      if ((data['v'] === 'gcm' || data['v'] === 4) && typeof data['payload'] === 'string') {
        data = (await this.decryptGcm(data['payload'])) as Record<string, unknown>;
      }
      if (data['success'] === false) {
        continue;
      }

      const source = this.pickSource(data);
      if (!source) {
        continue;
      }

      const masterUrl =
        source.type === 'hls' ? this.proxifyStreamUrl(source.url) : source.url;

      return {
        masterUrl,
        type: source.type,
        quality: source.quality,
        plug,
        imdbId: typeof data['imdbId'] === 'string' ? data['imdbId'] : null,
        tmdbId: (data['tmdbId'] as string | number | null) ?? options.id,
      };
    }

    throw new Error('No 111Movies plugs available on device');
  }

  private asObject(data: unknown): Record<string, unknown> | null {
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }

  private pickSource(data: Record<string, unknown>): {
    url: string;
    type: 'hls' | 'mp4';
    quality: string | null;
  } | null {
    const sources = Array.isArray(data['sources']) ? data['sources'] : [];
    const scored = sources
      .map((raw) => {
        const s = raw as Record<string, unknown>;
        const url =
          typeof s['url'] === 'string'
            ? s['url']
            : typeof s['file'] === 'string'
              ? s['file']
              : null;
        if (!url || !/^https?:\/\//i.test(url)) {
          return null;
        }
        const type = String(s['type'] || s['format'] || '').toLowerCase();
        const isHls = type === 'hls' || /\.m3u8(\?|$)/i.test(url) || /m3u8/i.test(url);
        const quality = String(s['quality'] || s['label'] || '');
        let rank = isHls ? 100 : 50;
        if (/1080/.test(quality)) rank += 20;
        else if (/720/.test(quality)) rank += 10;
        else if (/auto/i.test(quality)) rank += 15;
        return {
          url,
          type: (isHls ? 'hls' : 'mp4') as 'hls' | 'mp4',
          quality: quality || null,
          rank,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.rank - a.rank);
    const best = scored[0];
    return best
      ? { url: best.url, type: best.type, quality: best.quality }
      : null;
  }

  private proxifyStreamUrl(url: string): string {
    if (!this.apiBase) {
      return url;
    }
    try {
      const u = new URL(url);
      if (/ballerinacappuccinalovestungtungtungsahur\.com/i.test(u.host)) {
        return `${this.apiBase}/m3u8-proxy${u.pathname}${u.search}`;
      }
      if (/\.m3u8(\?|$)/i.test(u.pathname) || /m3u8/i.test(u.pathname + u.search)) {
        return `${this.apiBase}/m3u8-proxy/m3u8-proxy.m3u8?url=${encodeURIComponent(url)}`;
      }
    } catch {
      // keep original
    }
    return url;
  }

  private async decryptGcm(payloadB64: string): Promise<unknown> {
    const raw = Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0));
    if (raw.length < 44) {
      throw new Error('Invalid encrypted payload');
    }
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const tag = raw.slice(raw.length - 16);
    const data = raw.slice(28, raw.length - 16);
    const keyMaterial = new Uint8Array(GCM_KEY.length + salt.length);
    keyMaterial.set(new TextEncoder().encode(GCM_KEY), 0);
    keyMaterial.set(salt, GCM_KEY.length);
    const digest = await crypto.subtle.digest('SHA-256', keyMaterial);
    const key = await crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const cipher = new Uint8Array(data.length + tag.length);
    cipher.set(data, 0);
    cipher.set(tag, data.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      cipher
    );
    const text = new TextDecoder().decode(plain);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
