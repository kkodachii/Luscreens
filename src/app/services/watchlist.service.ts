import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface WatchlistItem {
  key: string;
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  addedAt: number;
}

export type WatchlistMap = Record<string, WatchlistItem>;

@Injectable({
  providedIn: 'root',
})
export class WatchlistService {
  private static readonly STORAGE_KEY = 'luscreensWatchlist';

  private userId: string | null = null;
  private readonly listSubject = new BehaviorSubject<WatchlistMap>(this.readMap());
  readonly list$ = this.listSubject.asObservable();

  bindToUser(userId: string | null): void {
    this.userId = userId;
    this.listSubject.next(this.readMap());
  }

  replaceMap(
    map: WatchlistMap,
    options: { persistLocal?: boolean } = {}
  ): void {
    const next = map && typeof map === 'object' ? map : {};
    if (options.persistLocal === false) {
      this.listSubject.next({ ...next });
      return;
    }
    this.writeMap(next);
  }

  getMap(): WatchlistMap {
    return this.listSubject.value;
  }

  getAll(): WatchlistItem[] {
    return Object.values(this.getMap()).sort((a, b) => b.addedAt - a.addedAt);
  }

  isInWatchlist(mediaType: string, id: number | string): boolean {
    return !!this.getMap()[this.toKey(mediaType, id)];
  }

  toggle(input: {
    mediaType: string;
    id: number | string;
    title?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
  }): boolean {
    if (this.isInWatchlist(input.mediaType, input.id)) {
      this.remove(input.mediaType, input.id);
      return false;
    }
    this.add(input);
    return true;
  }

  add(input: {
    mediaType: string;
    id: number | string;
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
    map[key] = {
      key,
      id,
      mediaType,
      title: input.title || (mediaType === 'tv' ? `TV #${id}` : `Movie #${id}`),
      posterPath: input.posterPath ?? null,
      backdropPath: input.backdropPath ?? null,
      addedAt: Date.now(),
    };
    this.writeMap(map);
  }

  remove(mediaType: string, id: number | string): void {
    const map = { ...this.getMap() };
    delete map[this.toKey(mediaType, id)];
    this.writeMap(map);
  }

  removeByKey(key: string): void {
    const map = { ...this.getMap() };
    delete map[key];
    this.writeMap(map);
  }

  clearAll(): void {
    this.writeMap({});
  }

  detailsLink(item: WatchlistItem): (string | number)[] {
    return ['/details', item.mediaType, item.id];
  }

  private toKey(mediaType: string, id: number | string): string {
    return `${mediaType === 'tv' ? 't' : 'm'}${id}`;
  }

  /**
   * Guest: browser cache only (`luscreensWatchlist`).
   * Logged in: per-user mirror (`luscreensWatchlist:{userId}`) + Render sync.
   */
  private storageKey(): string {
    return this.userId
      ? `${WatchlistService.STORAGE_KEY}:${this.userId}`
      : WatchlistService.STORAGE_KEY;
  }

  private readMap(): WatchlistMap {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? (JSON.parse(raw) as WatchlistMap) : {};
    } catch {
      return {};
    }
  }

  private writeMap(map: WatchlistMap): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(map));
      this.listSubject.next({ ...map });
    } catch (error) {
      console.error('Failed to save watchlist:', error);
    }
  }
}
