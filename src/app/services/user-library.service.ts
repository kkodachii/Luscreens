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
 * Keeps recently played / history / watchlist scoped to the logged-in user
 * and syncs them to the Render auth-api.
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
    // Defer so progress/watchlist constructors finish first
    queueMicrotask(() => {
      this.ready = true;
      this.lastUserId = this.auth.user()?.id ?? null;
      this.progress.bindToUser(this.lastUserId);
      this.watchlist.bindToUser(this.lastUserId);
      this.watchParty.bindToUser(this.lastUserId);
      if (this.lastUserId) {
        this.pullFromServer();
      }
    });

    effect(() => {
      const user = this.auth.user();
      const userId = user?.id ?? null;
      if (!this.ready || userId === this.lastUserId) {
        return;
      }

      const wasLoggedIn = !!this.lastUserId;
      this.lastUserId = userId;

      // Leaving an account — drop active party so it isn't mixed into guest
      if (wasLoggedIn && !userId) {
        this.watchParty.leaveParty();
      }

      this.progress.bindToUser(userId);
      this.watchlist.bindToUser(userId);
      this.watchParty.bindToUser(userId);

      if (userId) {
        this.pullFromServer();
      }
    });

    this.progress.progress$.subscribe(() => this.schedulePush());
    this.watchlist.list$.subscribe(() => this.schedulePush());
  }

  private authHeaders(): HttpHeaders | null {
    const token = this.auth.getToken();
    if (!token) {
      return null;
    }
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  private pullFromServer(): void {
    const headers = this.authHeaders();
    if (!this.baseUrl || !headers || !this.lastUserId) {
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
          if (!res?.library || this.auth.user()?.id !== this.lastUserId) {
            return;
          }
          this.progress.replaceMap(res.library.progress || {});
          this.watchlist.replaceMap(res.library.watchlist || {});
        } finally {
          // Allow a tick so replaceMap emissions don't immediately re-push
          setTimeout(() => {
            this.pulling = false;
          }, 50);
        }
      });
  }

  private schedulePush(): void {
    if (!this.ready || !this.lastUserId || !this.baseUrl || this.pulling) {
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => this.pushToServer(), 800);
  }

  private pushToServer(): void {
    const headers = this.authHeaders();
    if (!headers || !this.lastUserId) {
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
