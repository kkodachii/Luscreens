import { Injectable } from '@angular/core';

export interface VidphantomStreamInfo {
  masterUrl: string;
  name: string | null;
}

interface VidphantomSsePayload {
  done?: boolean;
  name?: string;
  proxiedUrl?: string;
  subtitles?: unknown[];
}

/**
 * Resolves VidPhantom HLS masters via their public SSE API.
 * Docs cover outbound PLAYER_EVENT only (no inbound play/seek), so we play
 * the proxied HLS feed in our own <video> with the Luscreens controller.
 * https://vidphantom.com/
 */
@Injectable({ providedIn: 'root' })
export class VidphantomStreamService {
  private readonly origin = 'https://vidphantom.com';
  private static readonly RESOLVE_TIMEOUT_MS = 28000;

  resolveStream(options: {
    mediaType: 'movie' | 'tv';
    id: string;
    season?: number;
    episode?: number;
  }): Promise<VidphantomStreamInfo> {
    const { mediaType, id, season, episode } = options;
    const path =
      mediaType === 'tv' && season != null && episode != null
        ? `/api/hls/tv/${id}/${season}/${episode}`
        : `/api/hls/movie/${id}`;

    const url = `${this.origin}${path}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let source: EventSource;

      try {
        source = new EventSource(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('EventSource failed'));
        return;
      }

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        source.close();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error('VidPhantom stream timed out')));
      }, VidphantomStreamService.RESOLVE_TIMEOUT_MS);

      source.onmessage = (event: MessageEvent<string>): void => {
        const raw = String(event.data || '').trim();
        if (!raw || raw === 'ping') {
          return;
        }

        let payload: VidphantomSsePayload;
        try {
          payload = JSON.parse(raw) as VidphantomSsePayload;
        } catch {
          return;
        }

        if (payload.proxiedUrl) {
          const masterUrl = new URL(payload.proxiedUrl, this.origin).href;
          finish(() =>
            resolve({
              masterUrl,
              name: typeof payload.name === 'string' ? payload.name : null,
            })
          );
          return;
        }

        if (payload.done) {
          finish(() => reject(new Error('VidPhantom returned no stream')));
        }
      };

      source.onerror = (): void => {
        // EventSource retries; only fail hard if we never got a stream
        if (source.readyState === EventSource.CLOSED) {
          finish(() => reject(new Error('VidPhantom SSE connection closed')));
        }
      };
    });
  }
}
