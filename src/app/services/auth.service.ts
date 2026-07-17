import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, map, of, retry, tap, throwError, timeout, timer } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  isAdmin?: boolean;
}

const ADMIN_EMAILS = ['kean@gmail.com'];

interface AuthResponse {
  token: string;
  user: AuthUser;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = (environment.authApiUrl || '').replace(/\/$/, '');
  private readonly tokenKey = 'luscreensAuthToken';
  private readonly userKey = 'luscreensAuthUser';
  private readonly rememberKey = 'luscreensAuthRemember';

  private readonly userSignal = signal<AuthUser | null>(this.readStoredUser());
  private readonly tokenSignal = signal<string | null>(this.readStoredToken());

  readonly user = this.userSignal.asReadonly();
  readonly isLoggedIn = computed(() => !!this.userSignal() && !!this.tokenSignal());
  readonly isAdmin = computed(() => {
    const email = (this.userSignal()?.email || '').trim().toLowerCase();
    if (this.userSignal()?.isAdmin === true) {
      return true;
    }
    return !!email && ADMIN_EMAILS.includes(email);
  });

  private readonly authModalOpenSignal = signal(false);
  private readonly authModalModeSignal = signal<'login' | 'register'>('login');
  readonly authModalOpen = this.authModalOpenSignal.asReadonly();
  readonly authModalMode = this.authModalModeSignal.asReadonly();

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  getToken(): string | null {
    return this.tokenSignal();
  }

  openAuthModal(mode: 'login' | 'register' = 'login'): void {
    this.authModalModeSignal.set(mode);
    this.authModalOpenSignal.set(true);
  }

  setAuthModalMode(mode: 'login' | 'register'): void {
    this.authModalModeSignal.set(mode);
  }

  closeAuthModal(): void {
    this.authModalOpenSignal.set(false);
  }

  constructor() {
    if (this.tokenSignal()) {
      this.refreshMe().subscribe();
    }
  }

  register(input: {
    email: string;
    password: string;
    name?: string;
    rememberMe?: boolean;
  }): Observable<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) {
      return of({ ok: false, error: 'Auth API is not configured' });
    }
    const rememberMe = input.rememberMe !== false;
    return this.http
      .post<AuthResponse>(`${this.baseUrl}/auth/register`, {
        email: input.email,
        password: input.password,
        name: input.name,
        rememberMe,
      })
      .pipe(
        timeout(45000),
        tap((res) => this.persistSession(res, rememberMe)),
        map(() => ({ ok: true as const })),
        catchError((err) =>
          of({ ok: false as const, error: this.toError(err, 'Could not create account') })
        )
      );
  }

  login(input: {
    email: string;
    password: string;
    rememberMe?: boolean;
  }): Observable<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) {
      return of({ ok: false, error: 'Auth API is not configured' });
    }
    const rememberMe = input.rememberMe !== false;
    return this.http
      .post<AuthResponse>(`${this.baseUrl}/auth/login`, {
        email: input.email,
        password: input.password,
        rememberMe,
      })
      .pipe(
        timeout(45000),
        tap((res) => this.persistSession(res, rememberMe)),
        map(() => ({ ok: true as const })),
        catchError((err) =>
          of({ ok: false as const, error: this.toError(err, 'Could not log in') })
        )
      );
  }

  logout(): void {
    this.clearStoredSession();
    this.tokenSignal.set(null);
    this.userSignal.set(null);
  }

  refreshMe(): Observable<AuthUser | null> {
    const token = this.tokenSignal();
    if (!this.enabled || !token) {
      return of(null);
    }
    return this.http
      .get<{ user: AuthUser }>(`${this.baseUrl}/auth/me`, {
        headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
      })
      .pipe(
        // Render free tier cold-start can take a while; retries cover the rest.
        timeout(45000),
        map((res) => {
          this.userSignal.set(res.user);
          this.writeUser(res.user);
          return res.user;
        }),
        retry({
          count: 2,
          delay: (error, retryCount) => {
            // Never retry a rejected credential — surface 401 immediately.
            if (this.isUnauthorizedError(error)) {
              return throwError(() => error);
            }
            // Backoff while the auth API wakes up (e.g. after ~1hr idle).
            const waitMs = retryCount === 1 ? 2000 : 5000;
            return timer(waitMs);
          },
        }),
        catchError((err: unknown) => {
          // Only clear session on real auth rejection — not timeouts / wake-ups / 5xx
          if (this.isUnauthorizedError(err)) {
            this.logout();
            return of(null);
          }
          return of(this.userSignal());
        })
      );
  }

  /** Admin only — list registered users. */
  listUsers(): Observable<
    { ok: true; users: AuthUser[]; total: number } | { ok: false; error: string }
  > {
    const token = this.tokenSignal();
    if (!this.enabled || !token) {
      return of({ ok: false, error: 'Not logged in' });
    }
    return this.http
      .get<{ users: AuthUser[]; total: number }>(`${this.baseUrl}/auth/admin/users`, {
        headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
      })
      .pipe(
        timeout(30000),
        map((res) => ({
          ok: true as const,
          users: res.users || [],
          total: res.total ?? (res.users || []).length,
        })),
        catchError((err) =>
          of({ ok: false as const, error: this.toError(err, 'Could not load users') })
        )
      );
  }

  /** Admin only — read another user's watch history / watchlist. */
  getUserLibraryAdmin(userId: string): Observable<
    | {
        ok: true;
        user: AuthUser;
        library: {
          progress: Record<string, unknown>;
          watchlist: Record<string, unknown>;
          updatedAt?: number | null;
        };
      }
    | { ok: false; error: string }
  > {
    const token = this.tokenSignal();
    if (!this.enabled || !token) {
      return of({ ok: false, error: 'Not logged in' });
    }
    const id = encodeURIComponent(String(userId || '').trim());
    if (!id) {
      return of({ ok: false, error: 'Missing user id' });
    }
    return this.http
      .get<{
        user: AuthUser;
        library: {
          progress: Record<string, unknown>;
          watchlist: Record<string, unknown>;
          updatedAt?: number | null;
        };
      }>(`${this.baseUrl}/auth/admin/users/${id}/library`, {
        headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
      })
      .pipe(
        timeout(30000),
        map((res) => ({
          ok: true as const,
          user: res.user,
          library: res.library || { progress: {}, watchlist: {}, updatedAt: null },
        })),
        catchError((err) =>
          of({
            ok: false as const,
            error: this.toError(err, 'Could not load user history'),
          })
        )
      );
  }

  private persistSession(res: AuthResponse, rememberMe: boolean): void {
    this.clearStoredSession();
    this.tokenSignal.set(res.token);
    this.userSignal.set(res.user);
    try {
      localStorage.setItem(this.rememberKey, rememberMe ? '1' : '0');
      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem(this.tokenKey, res.token);
      storage.setItem(this.userKey, JSON.stringify(res.user));
    } catch {
      // ignore
    }
  }

  private writeUser(user: AuthUser): void {
    try {
      const storage = this.activeStorage();
      storage.setItem(this.userKey, JSON.stringify(user));
    } catch {
      // ignore
    }
  }

  private activeStorage(): Storage {
    try {
      if (localStorage.getItem(this.rememberKey) === '0') {
        return sessionStorage;
      }
    } catch {
      // fall through
    }
    return localStorage;
  }

  private clearStoredSession(): void {
    try {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
      localStorage.removeItem(this.rememberKey);
    } catch {
      // ignore
    }
    try {
      sessionStorage.removeItem(this.tokenKey);
      sessionStorage.removeItem(this.userKey);
    } catch {
      // ignore
    }
  }

  private readStoredToken(): string | null {
    try {
      if (localStorage.getItem(this.rememberKey) === '0') {
        return sessionStorage.getItem(this.tokenKey) || localStorage.getItem(this.tokenKey);
      }
      return localStorage.getItem(this.tokenKey) || sessionStorage.getItem(this.tokenKey);
    } catch {
      return null;
    }
  }

  private readStoredUser(): AuthUser | null {
    try {
      const preferSession = localStorage.getItem(this.rememberKey) === '0';
      const raw = preferSession
        ? sessionStorage.getItem(this.userKey) || localStorage.getItem(this.userKey)
        : localStorage.getItem(this.userKey) || sessionStorage.getItem(this.userKey);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  }

  /** True when the auth API rejected the credential (not a cold-start / network blip). */
  private isUnauthorizedError(err: unknown): boolean {
    const status = (err as HttpErrorResponse)?.status;
    return status === 401 || status === 403;
  }

  private toError(err: unknown, fallback: string): string {
    const httpErr = err as { error?: { error?: string }; message?: string; name?: string };
    if (httpErr?.name === 'TimeoutError') {
      return 'Server is waking up — wait a few seconds and try again.';
    }
    return httpErr?.error?.error || httpErr?.message || fallback;
  }
}
