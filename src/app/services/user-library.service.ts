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
 * Logged in: those lists live on Render for that account (with a per-user local mirror).
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

    if (wasLoggedIn && !userId) {
      this.watchParty.leaveParty();
    }

    // Guest → cache only. Logged-in → user-scoped storage + Render.
    this.progress.bindToUser(userId);
    this.watchlist.bindToUser(userId);
    this.watchParty.bindToUser(userId);

    if (userId && this.canSyncToRender()) {
      this.pullFromServer();
    } else if (!initial && !userId) {
      // Explicitly ensure we are not talking to Render while logged out
      this.pulling = false;
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
      return;
    }

    this.pulling = true;
    this.http
      .get<{ library: UserLibrary }>(`${this.baseUrl}/me/library`, { headers })
      .pipe(
        timeout(30000),
        catchError(() => of(null))
      )
      .subscribe((res) => {
        try {
          if (!res?.library || !this.canSyncToRender() || this.auth.user()?.id !== this.lastUserId) {
            return;
          }
          // Server is source of truth while logged in
          this.progress.replaceMap(res.library.progress || {}, { persistLocal: true });
          this.watchlist.replaceMap(res.library.watchlist || {}, { persistLocal: true });
        } finally {
          setTimeout(() => {
            this.pulling = false;
          }, 50);
        }
      });
  }

  private schedulePush(): void {
    // Never push guest/cache data to Render
    if (!this.ready || !this.canSyncToRender() || this.pulling) {
      return;
    }
    this.clearSyncTimer();
    this.syncTimer = setTimeout(() => this.pushToServer(), 800);
  }

  private pushToServer(): void {
    const headers = this.authHeaders();
    if (!headers || !this.lastUserId || !this.canSyncToRender()) {
      return;
    }

    this.http
      .put(
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
      .subscribe();
  }
}
