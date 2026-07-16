import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface WatchProgressPoint {
  watched: number;
  duration: number;
}

export interface WatchProgressEpisode {
  season: number;
  episode: number;
  progress: WatchProgressPoint;
  last_updated?: number;
}

export interface WatchProgressEntry {
  id: number;
  type: 'movie' | 'tv';
  title?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  progress?: WatchProgressPoint;
  last_season_watched?: number;
  last_episode_watched?: number;
  show_progress?: Record<string, WatchProgressEpisode>;
  last_updated?: number;
  last_opened?: number;
}

export type WatchProgressMap = Record<string, WatchProgressEntry>;

export interface ContinueWatchingItem {
  key: string;
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  watched: number;
  duration: number;
  percent: number;
  season?: number;
  episode?: number;
  lastUpdated: number;
  frameLink: (string | number)[];
}

@Injectable({
  providedIn: 'root',
})
export class WatchProgressService {
  private static readonly STORAGE_KEY = 'vidFastProgress';
  /** Minimum watched time before resume/startAt kicks in. */
  private static readonly MIN_RESUME_SECONDS = 15;
  private static readonly MAX_RESUME_RATIO = 0.95;

  private userId: string | null = null;
  private readonly progressSubject = new BehaviorSubject<WatchProgressMap>(this.readMap());
  readonly progress$ = this.progressSubject.asObservable();

  /** Switch storage bucket when auth user changes. */
  bindToUser(userId: string | null): void {
    this.userId = userId;
    this.progressSubject.next(this.readMap());
  }

  /** Replace in-memory map (and optional local persist). */
  replaceMap(
    map: WatchProgressMap,
    options: { persistLocal?: boolean } = {}
  ): void {
    const next = map && typeof map === 'object' ? map : {};
    if (options.persistLocal === false) {
      this.progressSubject.next({ ...next });
      return;
    }
    this.writeMap(next);
  }

  getMap(): WatchProgressMap {
    return this.progressSubject.value;
  }

  /**
   * Accept either a full VidFast map (`{ m123: {...} }`) or a single entry (`{ id, type, ... }`).
   */
  saveMap(payload: unknown): void {
    const asMap = this.normalizeIncoming(payload);
    if (!asMap) {
      return;
    }
    this.writeMap(this.mergeEnrichment(asMap));
  }

  /** Call when the user opens a title so it shows in Recently Played immediately. */
  markOpened(input: {
    mediaType: 'movie' | 'tv' | string;
    id: number | string;
    season?: number;
    episode?: number;
    title?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
  }): void {
    const mediaType = input.mediaType === 'tv' ? 'tv' : 'movie';
    const id = Number(input.id);
    if (!id) {
      return;
    }

    const key = this.toKey(mediaType, id);
    const map = { ...this.getMap() };
    const existing = map[key] ?? { id, type: mediaType };
    const now = Date.now();

    const next: WatchProgressEntry = {
      ...existing,
      id,
      type: mediaType,
      title: input.title || existing.title,
      poster_path: input.posterPath ?? existing.poster_path ?? null,
      backdrop_path: input.backdropPath ?? existing.backdrop_path ?? null,
      last_opened: now,
      last_updated: now,
    };

    if (mediaType === 'tv') {
      next.last_season_watched =
        input.season ?? existing.last_season_watched ?? 1;
      next.last_episode_watched =
        input.episode ?? existing.last_episode_watched ?? 1;
    }

    map[key] = next;
    this.writeMap(map);
  }

  upsertPlayback(input: {
    mediaType: 'movie' | 'tv' | string;
    id: number | string;
    season?: number;
    episode?: number;
    watched: number;
    duration: number;
    title?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
  }): void {
    const mediaType = input.mediaType === 'tv' ? 'tv' : 'movie';
    const id = Number(input.id);
    if (!id || !Number.isFinite(input.watched)) {
      return;
    }

    const key = this.toKey(mediaType, id);
    const map = { ...this.getMap() };
    const existing = map[key] ?? { id, type: mediaType };
    const now = Date.now();

    const next: WatchProgressEntry = {
      ...existing,
      id,
      type: mediaType,
      title: input.title || existing.title,
      poster_path: input.posterPath ?? existing.poster_path ?? null,
      backdrop_path: input.backdropPath ?? existing.backdrop_path ?? null,
      last_updated: now,
      last_opened: existing.last_opened ?? now,
    };

    if (mediaType === 'tv') {
      const season = input.season ?? existing.last_season_watched ?? 1;
      const episode = input.episode ?? existing.last_episode_watched ?? 1;
      const episodeKey = `s${season}e${episode}`;
      next.last_season_watched = season;
      next.last_episode_watched = episode;
      next.show_progress = {
        ...(existing.show_progress ?? {}),
        [episodeKey]: {
          season,
          episode,
          progress: {
            watched: Math.max(0, input.watched),
            duration: Math.max(0, input.duration || 0),
          },
          last_updated: now,
        },
      };
    } else {
      next.progress = {
        watched: Math.max(0, input.watched),
        duration: Math.max(0, input.duration || 0),
      };
    }

    map[key] = next;
    this.writeMap(map);
  }

  getSavedStartAt(
    mediaType: 'movie' | 'tv' | string,
    id: number | string,
    season?: number,
    episode?: number
  ): number {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const entry = this.getMap()[this.toKey(type, id)];
    if (!entry) {
      return 0;
    }

    let watched = 0;
    let total = 0;

    if (type === 'tv') {
      const s = season ?? entry.last_season_watched ?? 1;
      const e = episode ?? entry.last_episode_watched ?? 1;
      const point = entry.show_progress?.[`s${s}e${e}`]?.progress;
      watched = point?.watched ?? 0;
      total = point?.duration ?? 0;
    } else {
      watched = entry.progress?.watched ?? 0;
      total = entry.progress?.duration ?? 0;
    }

    if (
      watched < WatchProgressService.MIN_RESUME_SECONDS ||
      (total > 0 && watched / total > WatchProgressService.MAX_RESUME_RATIO)
    ) {
      return 0;
    }

    return Math.floor(watched);
  }

  getResumeRoute(mediaType: 'movie' | 'tv' | string, id: number | string): (string | number)[] {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const numericId = Number(id);
    if (type === 'movie') {
      return ['/frame', 'movie', numericId];
    }

    const entry = this.getMap()[this.toKey('tv', numericId)];
    const season = entry?.last_season_watched || 1;
    const episode = entry?.last_episode_watched || 1;
    return ['/frame', 'tv', numericId, season, episode];
  }

  getContinueWatching(limit = 24): ContinueWatchingItem[] {
    const items: ContinueWatchingItem[] = [];

    for (const [key, entry] of Object.entries(this.getMap())) {
      if (!entry?.id || (entry.type !== 'movie' && entry.type !== 'tv')) {
        continue;
      }

      const snapshot = this.getDisplayProgress(entry);
      if (!snapshot) {
        continue;
      }

      items.push({
        key,
        id: entry.id,
        mediaType: entry.type,
        title: entry.title || (entry.type === 'tv' ? `TV #${entry.id}` : `Movie #${entry.id}`),
        posterPath: entry.poster_path ?? null,
        backdropPath: entry.backdrop_path ?? null,
        watched: snapshot.watched,
        duration: snapshot.duration,
        percent: snapshot.percent,
        season: snapshot.season,
        episode: snapshot.episode,
        lastUpdated: Math.max(
          entry.last_updated || 0,
          entry.last_opened || 0,
          snapshot.lastUpdated || 0
        ),
        frameLink: this.getResumeRoute(entry.type, entry.id),
      });
    }

    return items
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, limit);
  }

  remove(key: string): void {
    const map = { ...this.getMap() };
    delete map[key];
    this.writeMap(map);
  }

  enrichMetadata(input: {
    mediaType: 'movie' | 'tv' | string;
    id: number | string;
    title?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
  }): void {
    this.markOpened(input);
  }

  clearAll(): void {
    this.writeMap({});
  }

  formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  private getDisplayProgress(entry: WatchProgressEntry): {
    watched: number;
    duration: number;
    percent: number;
    season?: number;
    episode?: number;
    lastUpdated?: number;
  } | null {
    if (entry.type === 'tv') {
      const season = entry.last_season_watched ?? 1;
      const episode = entry.last_episode_watched ?? 1;
      const point = entry.show_progress?.[`s${season}e${episode}`];
      const watched = point?.progress?.watched ?? 0;
      const duration = point?.progress?.duration ?? 0;

      // Show in history if opened or has any meaningful progress
      if (!entry.last_opened && watched < 5) {
        return null;
      }
      if (duration > 0 && watched / duration > WatchProgressService.MAX_RESUME_RATIO) {
        // Finished — still show in history with 100%
        return {
          watched,
          duration,
          percent: 100,
          season,
          episode,
          lastUpdated: point?.last_updated ?? entry.last_updated,
        };
      }
      return {
        watched,
        duration,
        percent: duration > 0 ? Math.min(99, Math.round((watched / duration) * 100)) : 0,
        season,
        episode,
        lastUpdated: point?.last_updated ?? entry.last_opened ?? entry.last_updated,
      };
    }

    const watched = entry.progress?.watched ?? 0;
    const duration = entry.progress?.duration ?? 0;
    if (!entry.last_opened && watched < 5) {
      return null;
    }
    if (duration > 0 && watched / duration > WatchProgressService.MAX_RESUME_RATIO) {
      return {
        watched,
        duration,
        percent: 100,
        lastUpdated: entry.last_updated,
      };
    }
    return {
      watched,
      duration,
      percent: duration > 0 ? Math.min(99, Math.round((watched / duration) * 100)) : 0,
      lastUpdated: entry.last_opened ?? entry.last_updated,
    };
  }

  private normalizeIncoming(payload: unknown): WatchProgressMap | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const obj = payload as Record<string, unknown>;

    // Single entry: { id, type, progress?, ... }
    if (
      typeof obj['id'] === 'number' &&
      (obj['type'] === 'movie' || obj['type'] === 'tv')
    ) {
      const entry = obj as unknown as WatchProgressEntry;
      const key = this.toKey(entry.type, entry.id);
      return { [key]: { ...entry, last_updated: entry.last_updated ?? Date.now() } };
    }

    // Full map: { m123: {...}, t456: {...} }
    const map: WatchProgressMap = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as WatchProgressEntry;
      if (!entry.id || (entry.type !== 'movie' && entry.type !== 'tv')) {
        // Infer from key prefix if needed
        if (/^m\d+$/i.test(key)) {
          map[key] = {
            ...(entry as WatchProgressEntry),
            id: entry.id || Number(key.slice(1)),
            type: 'movie',
            last_updated: entry.last_updated ?? Date.now(),
          };
          continue;
        }
        if (/^t\d+$/i.test(key)) {
          map[key] = {
            ...(entry as WatchProgressEntry),
            id: entry.id || Number(key.slice(1)),
            type: 'tv',
            last_updated: entry.last_updated ?? Date.now(),
          };
          continue;
        }
        continue;
      }
      map[key] = {
        ...entry,
        last_updated: entry.last_updated ?? Date.now(),
      };
    }

    return Object.keys(map).length ? map : null;
  }

  private mergeEnrichment(incoming: WatchProgressMap): WatchProgressMap {
    const current = this.getMap();
    const merged: WatchProgressMap = { ...current, ...incoming };

    for (const [key, entry] of Object.entries(incoming)) {
      const prev = current[key];
      if (!prev) {
        merged[key] = {
          ...entry,
          last_updated: entry.last_updated ?? Date.now(),
        };
        continue;
      }
      merged[key] = {
        ...prev,
        ...entry,
        title: entry.title || prev.title,
        poster_path: entry.poster_path ?? prev.poster_path ?? null,
        backdrop_path: entry.backdrop_path ?? prev.backdrop_path ?? null,
        last_opened: Math.max(entry.last_opened || 0, prev.last_opened || 0) || undefined,
        last_updated: Math.max(
          entry.last_updated || 0,
          prev.last_updated || 0,
          Date.now()
        ),
        show_progress: {
          ...(prev.show_progress ?? {}),
          ...(entry.show_progress ?? {}),
        },
      };
    }

    return merged;
  }

  private toKey(mediaType: 'movie' | 'tv', id: number | string): string {
    return `${mediaType === 'tv' ? 't' : 'm'}${id}`;
  }

  /**
   * Guest: browser cache only (`vidFastProgress`).
   * Logged in: per-user mirror (`vidFastProgress:{userId}`) + Render sync.
   */
  private storageKey(): string {
    return this.userId
      ? `${WatchProgressService.STORAGE_KEY}:${this.userId}`
      : WatchProgressService.STORAGE_KEY;
  }

  private readMap(): WatchProgressMap {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? (JSON.parse(raw) as WatchProgressMap) : {};
    } catch {
      return {};
    }
  }

  private writeMap(map: WatchProgressMap): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(map));
      this.progressSubject.next({ ...map });
    } catch (error) {
      console.error('Failed to save watch progress:', error);
    }
  }
}
