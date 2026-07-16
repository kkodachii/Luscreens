import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, catchError, map, timeout } from 'rxjs';
import { environment } from '../../environments/environment';

export type PartyVisibility = 'public' | 'private';

export interface PublicPartyRoom {
  code: string;
  visibility: PartyVisibility;
  hostName: string;
  title: string | null;
  mediaType: string | null;
  mediaId: string | null;
  posterPath: string | null;
  season: number | null;
  episode: number | null;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
}

@Injectable({
  providedIn: 'root',
})
export class PartyLobbyService {
  private readonly baseUrl = (environment.partyApiUrl || '').replace(/\/$/, '');

  constructor(private http: HttpClient) {}

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  listPublicRooms(): Observable<PublicPartyRoom[]> {
    if (!this.enabled) {
      return of([]);
    }
    return this.http.get<{ rooms: PublicPartyRoom[] }>(`${this.baseUrl}/rooms`).pipe(
      timeout(20000),
      map((res) => res.rooms || []),
      catchError((err) => {
        console.warn('Party lobby list failed:', err);
        return of([]);
      })
    );
  }

  registerRoom(input: {
    code: string;
    visibility: PartyVisibility;
    hostName: string;
    title?: string;
    mediaType?: string;
    mediaId?: string;
    posterPath?: string;
    season?: number;
    episode?: number;
    memberCount?: number;
  }): Observable<PublicPartyRoom | null> {
    if (!this.enabled) {
      return of(null);
    }
    return this.http
      .post<{ room: PublicPartyRoom }>(`${this.baseUrl}/rooms`, input)
      .pipe(
        timeout(20000),
        map((res) => res.room),
        catchError((err) => {
          console.warn('Party lobby register failed:', err);
          return of(null);
        })
      );
  }

  updateRoom(
    code: string,
    patch: Partial<{
      visibility: PartyVisibility;
      hostName: string;
      title: string | null;
      mediaType: string | null;
      mediaId: string | null;
      posterPath: string | null;
      season: number | null;
      episode: number | null;
      memberCount: number;
    }>
  ): Observable<PublicPartyRoom | null> {
    if (!this.enabled) {
      return of(null);
    }
    return this.http
      .patch<{ room: PublicPartyRoom }>(`${this.baseUrl}/rooms/${encodeURIComponent(code)}`, patch)
      .pipe(
        timeout(15000),
        map((res) => res.room),
        catchError(() => of(null))
      );
  }

  heartbeat(code: string, memberCount?: number, title?: string): Observable<boolean> {
    if (!this.enabled) {
      return of(false);
    }
    return this.http
      .post(`${this.baseUrl}/rooms/${encodeURIComponent(code)}/heartbeat`, {
        memberCount,
        title,
      })
      .pipe(
        timeout(15000),
        map(() => true),
        catchError(() => of(false))
      );
  }

  unregisterRoom(code: string): Observable<boolean> {
    if (!this.enabled) {
      return of(false);
    }
    return this.http.delete(`${this.baseUrl}/rooms/${encodeURIComponent(code)}`).pipe(
      timeout(15000),
      map(() => true),
      catchError(() => of(false))
    );
  }
}
