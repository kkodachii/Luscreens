import { Injectable, effect, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { catchError, of, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { WatchProgressMap, WatchProgressService } from './watch-progress.service';
import { WatchlistMap, WatchlistService } from './watchlist.service';
import { WatchPartyService } from './watch-party.service';
import { environment } from '../../environments/environment';

interface UserLibrary {
  progress: WatchProgressMap;
  watchlist: WatchlistMap;
  updatedAt?: number | null;
}

/**
 * Guest (logged out): recently played / history / watchlist stay in localStorage only.
 * Logged in: server (Mongo via Render) is source of truth; localStorage is only a mirror
 * after the first successful pull for that account.
 */
@Injectable({
  providedIn: 'root',
})
export class UserLibraryService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly progress = inject(WatchProgressService);
  private readonly watchlist = inject(WatchlistService);
  private readonly watchParty = inject(WatchPartyService);

  private readonly baseUrl = (environment.authApiUrl || '').replace(/\/$/, '');
  private lastUserId: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private pulling = false;
  /** True only after a successful server pull (logged-in) or for guests. */
  private libraryHydrated = false;
  /** Bumps to cancel in-flight pulls after clear/remove. */
  private pullGeneration = 0;
  /** While true, server pulls must not overwrite a fresh local clear. */
  private blockPulls = false;
  private flushRetries = 0;
  private static readonly MAX_FLUSH_RETRIES = 5;

  constructor() {
    queueMicrotask(() => {
      this.ready = true;
      this.applyAuthState(this.auth.user()?.id ?? null, true);
    });

    effect(() => {
      const userId = this.auth.user()?.id ?? null;
      if (!this.ready || userId === this.lastUserId) {
        return;
      }
      this.applyAuthState(userId, false);
    });

    this.progress.progress$.subscribe(() => this.schedulePush());
    this.watchlist.list$.subscribe(() => this.schedulePush());
  }

  private applyAuthState(userId: string | null, initial: boolean): void {
    const wasLoggedIn = !!this.lastUserId;
    this.lastUserId = userId;

    this.clearSyncTimer();
    this.libraryHydrated = false;
    this.blockPulls = false;
    this.flushRetries = 0;
    this.pullGeneration += 1;

    if (wasLoggedIn && !userId) {
      this.watchParty.leaveParty();
    }

    const shouldPull = !!userId && this.canSyncToRender();

    // Block pushes before bindToUser emits (bind used to schedule a push of stale cache)
    this.pulling = shouldPull;

    this.progress.bindToUser(userId);
    this.watchlist.bindToUser(userId);
    this.watchParty.bindToUser(userId);

    if (shouldPull) {
      this.pullFromServer();
    } else {
      // Guest: local cache only
      this.pulling = false;
      this.libraryHydrated = true;
    }
  }

  private canSyncToRender(): boolean {
    return !!this.baseUrl && !!this.lastUserId && !!this.auth.getToken() && this.auth.isLoggedIn();
  }

  private authHeaders(): HttpHeaders | null {
    if (!this.canSyncToRender()) {
      return null;
    }
    const token = this.auth.getToken();
    return token
      ? new HttpHeaders({ Authorization: `Bearer ${token}` })
      : null;
  }

  private clearSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private pullFromServer(): void {
    const headers = this.authHeaders();
    if (!headers || !this.lastUserId) {
      this.pulling = false;
      return;
    }

    if (this.blockPulls) {
      this.pulling = false;
      return;
    }

    const generation = ++this.pullGeneration;
    this.pulling = true;
    this.libraryHydrated = false;
    this.clearSyncTimer();

    this.http
      .get<{ library: UserLibrary }>(`${this.baseUrl}/me/library`, { headers })
      .pipe(
        timeout(45000),
        catchError(() => of(null))
      )
      .subscribe((res) => {
        try {
          if (generation !== this.pullGeneration || this.blockPulls) {
            return;
          }
          if (!this.canSyncToRender() || this.auth.user()?.id !== this.lastUserId) {
            return;
          }

          if (!res?.library) {
            this.libraryHydrated = false;
            console.warn('Library pull failed — not pushing local cache to server');
            return;
          }

          // Server is source of truth while logged in (suppressed keys still stripped)
          this.progress.replaceMap(res.library.progress || {}, { persistLocal: true });
          this.watchlist.replaceMap(res.library.watchlist || {}, { persistLocal: true });
          this.libraryHydrated = true;

          // If suppressions emptied titles the server still has, push the cleaned map
          const serverProgress = res.library.progress || {};
          const localProgress = this.progress.getMap();
          if (Object.keys(serverProgress).length > Object.keys(localProgress).length) {
            this.flushToServer();
          }
        } finally {
          if (generation === this.pullGeneration) {
            this.pulling = false;
          }
        }
      });
  }

  private schedulePush(): void {
    if (
      !this.ready ||
      !this.canSyncToRender() ||
      this.pulling ||
      !this.libraryHydrated ||
      this.blockPulls
    ) {
      return;
    }
    this.clearSyncTimer();
    this.syncTimer = setTimeout(() => this.pushToServer(), 800);
  }

  private pushToServer(onDone?: (ok: boolean) => void): void {
    if (this.pulling || !this.libraryHydrated) {
      onDone?.(false);
      return;
    }

    const headers = this.authHeaders();
    if (!headers || !this.lastUserId || !this.canSyncToRender()) {
      onDone?.(false);
      return;
    }

    this.http
      .put<{ library: UserLibrary }>(
        `${this.baseUrl}/me/library`,
        {
          progress: this.progress.getMap(),
          watchlist: this.watchlist.getMap(),
        },
        { headers }
      )
      .pipe(
        timeout(30000),
        catchError(() => of(null))
      )
      .subscribe({
        next: (res) => onDone?.(!!res?.library),
        error: () => onDone?.(false),
      });
  }

  /**
   * Force an immediate sync after clear/remove so Mongo matches the UI.
   * Blocks server pulls until the PUT succeeds (prevents cleared items coming back).
   */
  flushToServer(resetRetries = true): void {
    if (!this.canSyncToRender()) {
      return;
    }

    if (resetRetries) {
      this.flushRetries = 0;
    }

    // Cancel any in-flight pull that could restore old Mongo data over the clear
    this.pullGeneration += 1;
    this.blockPulls = true;
    this.pulling = false;
    this.libraryHydrated = true;
    this.clearSyncTimer();

    this.pushToServer((ok) => {
      if (ok) {
        this.blockPulls = false;
        this.flushRetries = 0;
        return;
      }
      if (this.flushRetries >= UserLibraryService.MAX_FLUSH_RETRIES) {
        // Local suppressions still strip restored titles on pull; don't block forever
        this.blockPulls = false;
        this.flushRetries = 0;
        console.warn('Library flush failed — local clear kept via suppress list');
        return;
      }
      this.flushRetries += 1;
      window.setTimeout(
        () => this.flushToServer(false),
        1500 * this.flushRetries
      );
    });
  }
}
