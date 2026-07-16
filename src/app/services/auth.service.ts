import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, map, of, tap, timeout } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

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

  private readonly userSignal = signal<AuthUser | null>(this.readStoredUser());
  private readonly tokenSignal = signal<string | null>(this.readStoredToken());

  readonly user = this.userSignal.asReadonly();
  readonly isLoggedIn = computed(() => !!this.userSignal() && !!this.tokenSignal());

  get enabled(): boolean {
    return !!this.baseUrl;
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
  }): Observable<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) {
      return of({ ok: false, error: 'Auth API is not configured' });
    }
    return this.http
      .post<AuthResponse>(`${this.baseUrl}/auth/register`, input)
      .pipe(
        timeout(30000),
        tap((res) => this.persistSession(res)),
        map(() => ({ ok: true as const })),
        catchError((err) => of({ ok: false as const, error: this.toError(err, 'Could not create account') }))
      );
  }

  login(input: {
    email: string;
    password: string;
  }): Observable<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) {
      return of({ ok: false, error: 'Auth API is not configured' });
    }
    return this.http
      .post<AuthResponse>(`${this.baseUrl}/auth/login`, input)
      .pipe(
        timeout(30000),
        tap((res) => this.persistSession(res)),
        map(() => ({ ok: true as const })),
        catchError((err) => of({ ok: false as const, error: this.toError(err, 'Could not log in') }))
      );
  }

  logout(): void {
    try {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
    } catch {
      // ignore
    }
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
        timeout(20000),
        map((res) => {
          this.userSignal.set(res.user);
          try {
            localStorage.setItem(this.userKey, JSON.stringify(res.user));
          } catch {
            // ignore
          }
          return res.user;
        }),
        catchError(() => {
          this.logout();
          return of(null);
        })
      );
  }

  private persistSession(res: AuthResponse): void {
    this.tokenSignal.set(res.token);
    this.userSignal.set(res.user);
    try {
      localStorage.setItem(this.tokenKey, res.token);
      localStorage.setItem(this.userKey, JSON.stringify(res.user));
    } catch {
      // ignore
    }
  }

  private readStoredToken(): string | null {
    try {
      return localStorage.getItem(this.tokenKey);
    } catch {
      return null;
    }
  }

  private readStoredUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(this.userKey);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  }

  private toError(err: unknown, fallback: string): string {
    const httpErr = err as { error?: { error?: string }; message?: string; name?: string };
    if (httpErr?.name === 'TimeoutError') {
      return 'Server is waking up — wait a few seconds and try again.';
    }
    return httpErr?.error?.error || httpErr?.message || fallback;
  }
}
