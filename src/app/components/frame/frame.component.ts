import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { inject } from '@vercel/analytics';
import { environment } from '../../../environments/environment';
import { WatchProgressService } from '../../services/watch-progress.service';
import { AuthService } from '../../services/auth.service';
import {
  WatchPartyChatMessage,
  WatchPartyCommand,
  WatchPartyService,
  WatchPartyState,
} from '../../services/watch-party.service';

/** Chromium Document Picture-in-Picture (not on Window by default in TS libs). */
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

type PlayerEventName = 'play' | 'pause' | 'seeked' | 'ended' | 'timeupdate' | 'playerstatus';

interface PlayerEventData {
  event: PlayerEventName;
  currentTime: number;
  duration: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  season?: number;
  episode?: number;
  playing: boolean;
  muted: boolean;
  volume: number;
}

@Component({
  selector: 'app-frame',
  templateUrl: './frame.component.html',
  imports: [NgIf, FormsModule, NgForOf, CommonModule],
  styleUrls: ['./frame.component.css'],
  standalone: true,
})
export class FrameComponent implements OnInit, OnDestroy {

  private readonly vidfastOrigins = [
    'https://vidfast.pro',
    'https://vidfast.in',
    'https://vidfast.io',
    'https://vidfast.me',
    'https://vidfast.net',
    'https://vidfast.pm',
    'https://vidfast.xyz',
    'https://vidfast.vc',
    'https://vidfast.bz',
  ];

  private readonly onPlayerMessage = (event: MessageEvent): void => {
    this.handleVidfastMessage(event);
  };

  embedUrl: SafeResourceUrl | null = null;
  mediaType: string = '';
  id: string = '';
  seasons: any[] = [];
  episodes: any[] = [];
  selectedSeason: number = 1;
  selectedEpisode: number = 1;
  backdropPath: string | null = null;
  posterPath: string | null = null;
  item: { logo_path: string | null } = {
    logo_path: null,
  };

  // New properties for title, rating, release date, and details
  title: string = '';
  rating: number = 0;
  releaseDate: string = '';
  details: string = '';
  isLoading: boolean = true;

  // Custom player state (driven by VidFast PLAYER_EVENT)
  isPlaying = false;
  currentTime = 0;
  duration = 0;
  isSeeking = false;
  isFullscreen = false;
  /** Overlay controls — visible on tap; auto-hide after 4s while playing. */
  showPlayerControls = true;
  private controlsHideTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CONTROLS_HIDE_MS = 4000;
  isPictureInPicture = false;
  readonly supportsDocumentPip =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  private pipWindow: Window | null = null;
  private pipPlaceholder: HTMLElement | null = null;

  // Subtitles / server (VidFast URL params)
  readonly subtitleOptions: { code: string | null; label: string }[] = [
    { code: null, label: 'Off' },
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'zh', label: 'Chinese' },
  ];
  selectedSubtitle: string | null = null;
  selectedServer: string = environment.streamServer || 'vEdge';
  /** When true, omit `server=` so VidFast can pick a working source itself. */
  useAutoServer = false;
  showCcMenu = false;
  showServerMenu = false;
  isPlayerReloading = false;
  playerReloadLabel = 'Loading…';

  /** Auto-failover: try next server if current one never starts playback. */
  private static readonly SERVER_FAILOVER_MS = 12000;
  private static readonly AUTO_SERVER_ID = 'auto';
  private serverFailoverTimer: ReturnType<typeof setTimeout> | null = null;
  private serversTriedThisTitle = new Set<string>();
  private serverPlaybackOk = false;

  get serverOptions(): { id: string; label: string }[] {
    const fromEnv = (environment as { streamServers?: string[] }).streamServers ?? [];
    const preferred = environment.streamServer || 'vEdge';
    const names = [preferred, ...fromEnv].filter(Boolean);
    // Auto first (VidFast picks), then preferred, then the rest
    return [
      { id: FrameComponent.AUTO_SERVER_ID, label: 'Auto' },
      ...[...new Set(names)].map((id) => ({ id, label: id })),
    ];
  }

  get activeServerLabel(): string {
    return this.useAutoServer ? 'Auto' : this.selectedServer || 'Auto';
  }

  // Watch party
  watchParty: WatchPartyState = {
    role: null,
    roomCode: null,
    connected: false,
    connecting: false,
    members: [],
    error: null,
    inviteUrl: null,
  };
  showWatchPartyPanel = false;
  showJoinInviteModal = false;
  watchPartyMode: 'create' | 'join' = 'create';
  watchPartyName = '';
  joinRoomCode = '';
  watchPartyCopied = false;
  partyChatMessages: WatchPartyChatMessage[] = [];
  partyChatDraft = '';
  /** Collapsible chat inside the watch-party panel (non-fullscreen). */
  showPartyChat = true;
  /** Floating chat overlay while the player is fullscreen. */
  showFloatingPartyChat = false;
  partyChatUnread = 0;
  private watchPartySubs = new Subscription();
  private ignorePartyBroadcastUntil = 0;
  private lastLocalProgressSaveAt = 0;
  private lastClearedRestartAt = 0;
  /** Only auto-correct embed resume for cleared titles during this window. */
  private clearedBootstrapUntil = 0;
  /** True once playback was near 0 or the user scrubbed — stop fighting seeks. */
  private clearedSessionReady = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onFullscreenChange = (): void => {
    this.isFullscreen = !!document.fullscreenElement;
    this.revealPlayerControls();
  };
  

  @ViewChild('seasonScroll') seasonScroll!: ElementRef;
  @ViewChild('episodeScroll') episodeScroll!: ElementRef;
  @ViewChild('playerIframe') playerIframe!: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerContainer') playerContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('partyChatScroll') partyChatScroll?: ElementRef<HTMLDivElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private tmdbService: TmdbService,
    private watchPartyService: WatchPartyService,
    private watchProgress: WatchProgressService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
  ) {}

  get isGuest(): boolean {
    return !this.authService.isLoggedIn();
  }

  getWatchPartyDisplayName(fallback: string): string {
    const accountName = this.authService.user()?.name?.trim();
    if (accountName) {
      return accountName;
    }
    return this.watchPartyName.trim() || fallback;
  }

  ngOnInit(): void {
    // Initialize Vercel Analytics
    inject();

    window.addEventListener('message', this.onPlayerMessage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.setupWatchParty();
    this.startProgressTimer();

    this.mediaType = this.route.snapshot.paramMap.get('media_type') || '';
    this.id = this.route.snapshot.paramMap.get('id') || '';

    const seasonParam = this.route.snapshot.paramMap.get('season');
    const episodeParam = this.route.snapshot.paramMap.get('episode');
    if (seasonParam) {
      this.selectedSeason = +seasonParam;
    }
    if (episodeParam) {
      this.selectedEpisode = +episodeParam;
    }

    if (this.mediaType && this.id) {
      this.beginClearedBootstrapIfNeeded();
      if (this.mediaType === 'movie') {
        this.fetchMovieDetails();
      } else if (this.mediaType === 'tv') {
        this.fetchTvDetails();
      } else {
        console.error('Invalid media type.');
      }
      this.fetchLogo(this.mediaType, +this.id);
    } else {
      console.error('Missing required route parameters.');
    }

    void this.tryRestoreWatchParty();
  }

  ngOnDestroy(): void {
    this.persistLocalProgress(true);
    this.stopProgressTimer();
    this.clearControlsHideTimer();
    this.clearServerFailoverWatch();
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.closePictureInPicture();
    this.watchPartySubs.unsubscribe();
    // Do NOT tear down PeerJS here — WatchPartyService is root-scoped and must
    // stay alive when the host changes titles. leaveParty() / beforeunload handle cleanup.
  }

  private readonly onBeforeUnload = (): void => {
    this.persistLocalProgress(true);
    // Release the PeerJS id so a reload can reclaim the same room code quickly
    this.watchPartyService.disconnectKeepingSession();
  };

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      if (this.isPlaying || this.currentTime > 5) {
        this.persistLocalProgress(false);
      }
    }, 8000);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  fetchLogo(mediaType: string, id: number): void {
    if (mediaType === 'movie') {
      // Fetch movie logos
      this.tmdbService.getMovieImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching movie logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else if (mediaType === 'tv') {
      // Fetch TV show logos
      this.tmdbService.getTvImages(id).subscribe(
        (imagesData: any) => {
          const logo = imagesData.logos.find((logo: any) => logo.iso_639_1 === 'en'); // Find English logo
          this.item.logo_path = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
        },
        (error) => {
          console.error('Error fetching TV show logo:', error);
          this.item.logo_path = null; // Fallback if no logo is found
        }
      );
    } else {
      console.error('Invalid media type for logo fetching.');
      this.item.logo_path = null;
    }
  }

  fetchMovieDetails(): void {
    this.tmdbService.getMovieDetails(+this.id).subscribe(
      (data: any) => {
        this.backdropPath = data.backdrop_path;
        this.posterPath = data.poster_path ?? null;
        this.title = data.title || 'Unknown Movie'; // Set the title with a fallback
        this.rating = data.vote_average || 0;
        this.releaseDate = data.release_date || 'Unknown Release Date';
        this.details = data.overview || 'No details available.';
        this.isLoading = false; // Mark loading as complete

        this.embedUrl = this.buildEmbedUrl(`movie/${this.id}`);
        this.syncWatchPartyMedia();
        this.watchProgress.enrichMetadata({
          mediaType: 'movie',
          id: this.id,
          title: this.title,
          posterPath: data.poster_path ?? null,
          backdropPath: data.backdrop_path ?? null,
        });
      },
      (error) => {
        console.error('Error fetching movie details:', error);
        this.isLoading = false; // Mark loading as complete even if there's an error
      }
    );
  }

  fetchTvDetails(): void {
    this.tmdbService.getTvDetails(+this.id).subscribe(
      (data: any) => {
        this.backdropPath = data.backdrop_path;
        this.posterPath = data.poster_path ?? null;
        this.title = data.name || 'Unknown TV Show'; // Set the title with a fallback
        this.rating = data.vote_average || 0;
        this.releaseDate = data.first_air_date || 'Unknown Release Date';
        this.details = data.overview || 'No details available.';
        this.isLoading = false; // Mark loading as complete

        this.seasons = data.seasons.filter((season: any) => season.season_number > 0);
        if (this.seasons.length > 0) {
          const hasRouteSeason = this.seasons.some(
            (season) => season.season_number === this.selectedSeason
          );
          if (!hasRouteSeason) {
            this.selectedSeason = this.seasons[0].season_number;
          }
          this.fetchEpisodes(this.selectedSeason);
        } else {
          console.error('No seasons found for this TV show.');
        }

        this.watchProgress.enrichMetadata({
          mediaType: 'tv',
          id: this.id,
          title: this.title,
          posterPath: data.poster_path ?? null,
          backdropPath: data.backdrop_path ?? null,
        });
        this.syncWatchPartyMedia();
      },
      (error) => {
        console.error('Error fetching TV show details:', error);
        this.isLoading = false; // Mark loading as complete even if there's an error
      }
    );
  }

  fetchEpisodes(seasonNumber: number): any {
    // Return the observable from the service call
    return this.tmdbService.getSeasonDetails(+this.id, seasonNumber).subscribe(
      (data: any) => {
        this.episodes = data.episodes;
        if (this.episodes.length > 0) {
          const hasRouteEpisode = this.episodes.some(
            (episode) => episode.episode_number === this.selectedEpisode
          );
          if (!hasRouteEpisode) {
            this.selectedEpisode = this.episodes[0].episode_number;
          }
          this.updateEmbedUrl();
        } else {
          console.error(`No episodes found for Season ${seasonNumber}.`);
        }
      },
      (error) => {
        console.error('Error fetching episodes:', error);
      }
    );
  }
  
  selectSeason(seasonNumber: number): void {
    this.selectedSeason = seasonNumber;
    this.resetServerFailoverState();
    this.fetchEpisodes(this.selectedSeason);
  }
  
  selectEpisode(episodeNumber: number): void {
    this.selectedEpisode = episodeNumber;
    this.resetServerFailoverState();
    this.updateEmbedUrl();
  }

  updateEmbedUrl(): void {
    if (this.mediaType === 'tv') {
      this.resetPlayerState();
      this.embedUrl = this.buildEmbedUrl(
        `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
      );
      this.syncWatchPartyMedia();
    }
  }

  private buildEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'red',
      title: 'false',
      // Reduce embed chrome so users rely on our custom controls instead
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
    });

    // Omit server in Auto mode so VidFast can find a working source itself
    if (!this.useAutoServer && this.selectedServer) {
      params.set('server', this.selectedServer);
    }

    if (this.selectedSubtitle) {
      params.set('sub', this.selectedSubtitle);
    }

    const cleared = this.watchProgress.isSuppressed(this.mediaType, this.id);
    const startAt = cleared
      ? 0
      : resumeAt != null && resumeAt > 0
        ? resumeAt
        : this.getSavedStartAt();
    // Always set startAt — omitting it lets VidFast resume from its own iframe cache
    // (which brought back cleared history timestamps).
    params.set('startAt', String(Math.max(0, Math.floor(startAt))));

    if (this.mediaType === 'tv') {
      params.set('nextButton', 'true');
      params.set('autoNext', 'true');
    }

    const url = `https://vidfast.vc/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private getEmbedPath(): string | null {
    if (!this.id || !this.mediaType) {
      return null;
    }
    if (this.mediaType === 'movie') {
      return `movie/${this.id}`;
    }
    if (this.mediaType === 'tv') {
      return `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`;
    }
    return null;
  }

  private reloadPlayer(resumeAt?: number, label = 'Loading…'): void {
    const path = this.getEmbedPath();
    if (!path) {
      return;
    }
    const time = resumeAt ?? this.currentTime;
    this.playerReloadLabel = label;
    this.isPlayerReloading = true;
    // Keep previous frame painted under the overlay; swap src on next tick
    setTimeout(() => {
      this.embedUrl = this.buildEmbedUrl(path, time > 5 ? time : undefined);
    }, 50);
  }

  onPlayerIframeLoad(): void {
    this.isPlayerReloading = false;
    this.beginClearedBootstrapIfNeeded();
    this.requestPlayerStatus();
    this.armServerFailoverWatch();
  }

  toggleCcMenu(): void {
    this.showCcMenu = !this.showCcMenu;
    this.showServerMenu = false;
    this.revealPlayerControls();
  }

  toggleServerMenu(): void {
    this.showServerMenu = !this.showServerMenu;
    this.showCcMenu = false;
    this.revealPlayerControls();
  }

  selectSubtitle(code: string | null): void {
    if (this.selectedSubtitle === code) {
      this.showCcMenu = false;
      return;
    }
    this.selectedSubtitle = code;
    this.showCcMenu = false;
    // Soft-reload with sub= URL param (VidFast's supported way) — overlay avoids black flash
    this.reloadPlayer(this.currentTime, code ? 'Applying subtitles…' : 'Turning off subtitles…');
  }

  selectServer(server: string): void {
    const wantsAuto = server === FrameComponent.AUTO_SERVER_ID;
    if (wantsAuto) {
      if (this.useAutoServer) {
        this.showServerMenu = false;
        return;
      }
      this.useAutoServer = true;
    } else {
      if (!this.useAutoServer && this.selectedServer === server) {
        this.showServerMenu = false;
        return;
      }
      this.useAutoServer = false;
      this.selectedServer = server;
    }
    this.showServerMenu = false;
    this.resetServerFailoverState();
    this.reloadPlayer(
      this.currentTime,
      wantsAuto ? 'Finding a server…' : `Switching to ${server}…`
    );
  }

  private resetServerFailoverState(): void {
    this.clearServerFailoverWatch();
    this.serversTriedThisTitle.clear();
    this.serverPlaybackOk = false;
  }

  private clearServerFailoverWatch(): void {
    if (this.serverFailoverTimer != null) {
      clearTimeout(this.serverFailoverTimer);
      this.serverFailoverTimer = null;
    }
  }

  private armServerFailoverWatch(): void {
    this.clearServerFailoverWatch();
    if (this.serverPlaybackOk) {
      return;
    }

    const triedKey = this.useAutoServer
      ? FrameComponent.AUTO_SERVER_ID
      : this.selectedServer;
    if (triedKey) {
      this.serversTriedThisTitle.add(triedKey);
    }

    this.serverFailoverTimer = setTimeout(() => {
      this.tryNextServerFailover();
    }, FrameComponent.SERVER_FAILOVER_MS);
  }

  private markServerPlaybackOk(): void {
    if (this.serverPlaybackOk) {
      return;
    }
    if (this.duration > 1 || this.currentTime > 0.5 || this.isPlaying) {
      this.serverPlaybackOk = true;
      this.clearServerFailoverWatch();
    }
  }

  /** Current server never started — try the next one, then VidFast Auto. */
  private tryNextServerFailover(): void {
    if (this.serverPlaybackOk || this.isPlayerReloading) {
      return;
    }

    const pinnedServers = this.serverOptions
      .map((s) => s.id)
      .filter((id) => id !== FrameComponent.AUTO_SERVER_ID);

    const nextPinned = pinnedServers.find((id) => !this.serversTriedThisTitle.has(id));
    if (nextPinned) {
      this.useAutoServer = false;
      this.selectedServer = nextPinned;
      this.reloadPlayer(this.currentTime, `Trying ${nextPinned}…`);
      return;
    }

    if (!this.serversTriedThisTitle.has(FrameComponent.AUTO_SERVER_ID)) {
      this.useAutoServer = true;
      this.reloadPlayer(this.currentTime, 'Finding a working server…');
      return;
    }

    this.playerReloadLabel = 'No working server found';
    this.isPlayerReloading = true;
    setTimeout(() => {
      if (!this.serverPlaybackOk) {
        this.isPlayerReloading = false;
        this.cdr.detectChanges();
      }
    }, 2500);
  }

  private resetPlayerState(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.isSeeking = false;
    this.beginClearedBootstrapIfNeeded();
  }

  private beginClearedBootstrapIfNeeded(): void {
    this.lastClearedRestartAt = 0;
    if (this.id && this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      this.clearedBootstrapUntil = Date.now() + 10000;
      this.clearedSessionReady = false;
      return;
    }
    this.clearedBootstrapUntil = 0;
    this.clearedSessionReady = true;
  }

  private handleVidfastMessage(event: MessageEvent): void {
    if (!event.data) {
      return;
    }
    // Allow known VidFast hosts; also accept if origin host contains "vidfast"
    const originOk =
      this.vidfastOrigins.includes(event.origin) ||
      /vidfast\./i.test(event.origin || '');
    if (!originOk) {
      return;
    }

    const payload = event.data;
    const type = payload?.type || payload?.eventType;
    const data = payload?.data ?? payload?.payload ?? payload;

    if (type === 'PLAYER_EVENT' && data) {
      this.onPlayerEvent(data as PlayerEventData);
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      // Ignore VidFast's stored progress map — it re-imports cleared history/timestamps.
      // Our PLAYER_EVENT upsertPlayback is the only progress source.
      return;
    }

    // Error / failure messages from the embed (names vary by VidFast build)
    const errorType = String(type || '').toLowerCase();
    if (
      errorType.includes('error') ||
      errorType === 'playback_error' ||
      errorType === 'player_error'
    ) {
      this.tryNextServerFailover();
      return;
    }

    // Some embeds send player fields without wrapping type
    if (
      data &&
      typeof data === 'object' &&
      ('currentTime' in data || 'event' in data) &&
      ((data as PlayerEventData).event || (data as PlayerEventData).playing !== undefined)
    ) {
      this.onPlayerEvent(data as PlayerEventData);
    }
  }

  private onPlayerEvent(data: PlayerEventData): void {
    if (!this.isSeeking || data.event === 'seeked') {
      this.currentTime = Number(data.currentTime ?? this.currentTime) || this.currentTime;
    }

    this.duration = Number(data.duration ?? this.duration) || this.duration;
    const wasPlaying = this.isPlaying;
    if (typeof data.playing === 'boolean') {
      this.isPlaying = data.playing;
    }

    // Cleared titles: VidFast may ignore startAt=0 and jump to its own cached time
    if (this.enforceClearedRestart()) {
      return;
    }

    const eventName = String(data.event || '').toLowerCase();
    if (eventName === 'error' || eventName === 'playbackerror') {
      this.tryNextServerFailover();
      return;
    }

    switch (data.event) {
      case 'play':
        this.isPlaying = true;
        this.broadcastWatchPartyEvent('play', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'pause':
        this.isPlaying = false;
        this.broadcastWatchPartyEvent('pause', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'ended':
        this.isPlaying = false;
        this.persistLocalProgress(true);
        break;
      case 'seeked':
        this.isSeeking = false;
        this.broadcastWatchPartyEvent('seeked', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'timeupdate':
        this.persistLocalProgress(false);
        break;
      case 'playerstatus':
        this.persistLocalProgress(false);
        break;
      default:
        // Still persist when we get timed updates without a named event
        if (typeof data.currentTime === 'number' && data.currentTime > 0) {
          this.persistLocalProgress(false);
        }
        break;
    }

    this.markServerPlaybackOk();

    if (wasPlaying !== this.isPlaying) {
      this.onPlaybackStateChanged();
    }
  }

  /**
   * Cleared titles only: once, briefly after load, snap embed-cache resume back to 0.
   * Never runs after the user seeks or after we have seen a near-zero start.
   */
  private enforceClearedRestart(): boolean {
    if (!this.id || !this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      return false;
    }
    if (this.currentTime <= 8) {
      this.clearedSessionReady = true;
      return false;
    }
    // User scrubbing / skip buttons / already past bootstrap — allow free seeking
    if (this.isSeeking || this.clearedSessionReady || Date.now() > this.clearedBootstrapUntil) {
      return false;
    }
    const now = Date.now();
    if (now - this.lastClearedRestartAt < 1500) {
      this.currentTime = 0;
      return true;
    }
    this.lastClearedRestartAt = now;
    this.currentTime = 0;
    this.postPlayerCommand({ command: 'seek', time: 0 });
    return true;
  }

  private persistLocalProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLocalProgressSaveAt < 3000) {
      return;
    }
    if (!this.id) {
      return;
    }

    if (this.watchProgress.isSuppressed(this.mediaType, this.id)) {
      // Wait until we confirmed a fresh start (or user took control via seek)
      if (!this.clearedSessionReady) {
        return;
      }
      if (this.currentTime < 15) {
        return;
      }
    }

    // Prefer live player time; fall back to last saved resume point so we don't wipe history
    const watched = this.currentTime > 0 ? this.currentTime : this.getSavedStartAt();
    if (watched < 1 && !force) {
      return;
    }

    this.lastLocalProgressSaveAt = now;
    this.watchProgress.upsertPlayback({
      mediaType: this.mediaType,
      id: this.id,
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      watched,
      duration: this.duration,
      title: this.title,
      backdropPath: this.backdropPath,
    });
  }

  private getSavedStartAt(): number {
    return this.watchProgress.getSavedStartAt(
      this.mediaType,
      this.id,
      this.selectedSeason,
      this.selectedEpisode
    );
  }

  private postPlayerCommand(command: Record<string, unknown>): void {
    const contentWindow = this.playerIframe?.nativeElement?.contentWindow;
    if (!contentWindow) {
      return;
    }

    contentWindow.postMessage(command, '*');
  }

  togglePlayPause(): void {
    this.postPlayerCommand({ command: this.isPlaying ? 'pause' : 'play' });
    // Optimistic UI so controls don't hide before the player event arrives
    this.isPlaying = !this.isPlaying;
    this.onPlaybackStateChanged();
  }

  get seekProgressPercent(): string {
    if (!this.duration || this.duration <= 0) {
      return '0%';
    }
    const pct = Math.min(100, Math.max(0, (this.currentTime / this.duration) * 100));
    return `${pct}%`;
  }

  /** Tap video surface: show controls and toggle play/pause (avoids clicking into the embed). */
  onPlayerSurfaceTap(): void {
    if (this.isPlayerReloading) {
      return;
    }
    this.revealPlayerControls();
    this.togglePlayPause();
  }

  /** Mouse move over the video reveals controls while playing. */
  onPlayerSurfaceMove(): void {
    if (this.showPlayerControls) {
      this.scheduleControlsHide();
      return;
    }
    this.revealPlayerControls();
  }

  revealPlayerControls(): void {
    this.showPlayerControls = true;
    this.scheduleControlsHide();
  }

  private onPlaybackStateChanged(): void {
    if (!this.isPlaying) {
      this.showPlayerControls = true;
      this.clearControlsHideTimer();
      return;
    }
    this.scheduleControlsHide();
  }

  private scheduleControlsHide(): void {
    this.clearControlsHideTimer();
    if (!this.isPlaying || this.showCcMenu || this.showServerMenu) {
      return;
    }
    this.controlsHideTimer = setTimeout(() => {
      if (this.isPlaying && !this.showCcMenu && !this.showServerMenu) {
        this.showPlayerControls = false;
        this.cdr.detectChanges();
      }
    }, FrameComponent.CONTROLS_HIDE_MS);
  }

  private clearControlsHideTimer(): void {
    if (this.controlsHideTimer != null) {
      clearTimeout(this.controlsHideTimer);
      this.controlsHideTimer = null;
    }
  }

  seekTo(time: number): void {
    const clamped = Math.max(0, Math.min(time, this.duration || time));
    this.isSeeking = true;
    this.clearedSessionReady = true; // user took control — never snap seek back to 0
    this.currentTime = clamped;
    this.postPlayerCommand({ command: 'seek', time: clamped });
  }

  onSeekInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.isSeeking = true;
    this.clearedSessionReady = true;
    this.currentTime = value;
  }

  onSeekChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.seekTo(value);
  }

  skipBy(seconds: number): void {
    this.seekTo(this.currentTime + seconds);
  }

  requestPlayerStatus(): void {
    this.postPlayerCommand({ command: 'getStatus' });
  }

  async toggleFullscreen(): Promise<void> {
    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }

    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      this.revealPlayerControls();
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  }

  async togglePictureInPicture(): Promise<void> {
    if (!this.supportsDocumentPip) {
      return;
    }

    if (this.isPictureInPicture) {
      this.closePictureInPicture();
      return;
    }

    const container = this.playerContainer?.nativeElement;
    if (!container) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }

      const dpip = (window as unknown as { documentPictureInPicture: DocumentPictureInPicture })
        .documentPictureInPicture;
      const pipWindow = await dpip.requestWindow({
        width: Math.max(360, Math.round(container.clientWidth * 0.45)),
        height: Math.max(240, Math.round(container.clientHeight * 0.45)),
      });

      this.copyStylesToPipWindow(pipWindow);

      const placeholder = document.createElement('div');
      placeholder.className =
        'w-full aspect-video bg-black/80 rounded-lg flex items-center justify-center text-sm text-gray-400 border border-white/10';
      placeholder.textContent = 'Playing in Picture-in-Picture';
      container.parentNode?.insertBefore(placeholder, container);
      this.pipPlaceholder = placeholder;

      pipWindow.document.body.style.margin = '0';
      pipWindow.document.body.style.background = '#000';
      pipWindow.document.body.style.overflow = 'hidden';
      pipWindow.document.body.appendChild(container);

      this.pipWindow = pipWindow;
      this.isPictureInPicture = true;

      pipWindow.addEventListener('pagehide', () => {
        this.restorePlayerFromPip();
        this.cdr.markForCheck();
      });
    } catch (error) {
      console.error('Picture-in-Picture failed:', error);
      this.restorePlayerFromPip();
    }
  }

  private closePictureInPicture(): void {
    if (this.pipWindow && !this.pipWindow.closed) {
      this.pipWindow.close();
    }
    this.restorePlayerFromPip();
  }

  private restorePlayerFromPip(): void {
    const container = this.playerContainer?.nativeElement;
    const placeholder = this.pipPlaceholder;

    if (container && placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(container, placeholder);
      placeholder.remove();
    }

    this.pipPlaceholder = null;
    this.pipWindow = null;
    this.isPictureInPicture = false;
  }

  private copyStylesToPipWindow(pipWindow: Window): void {
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      pipWindow.document.head.appendChild(node.cloneNode(true));
    });
  }

  private setupWatchParty(): void {
    this.watchPartySubs.add(
      this.watchPartyService.state$.subscribe((state) => {
        this.watchParty = state;
        if (state.connected && state.roomCode) {
          this.syncPartyQueryParam(state.roomCode);
        }
        if (!state.connected) {
          this.partyChatMessages = [];
          this.partyChatDraft = '';
          this.partyChatUnread = 0;
          this.showFloatingPartyChat = false;
        }
        this.cdr.detectChanges();
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.remoteCommands$.subscribe((command) => {
        this.applyWatchPartyCommand(command);
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.syncRequested$.subscribe(() => {
        this.watchPartyService.broadcastSync(this.currentTime, this.isPlaying);
      })
    );

    this.watchPartySubs.add(
      this.watchPartyService.chatMessages$.subscribe((message) => {
        this.partyChatMessages = [...this.partyChatMessages, message].slice(-100);
        if (!message.isLocal && !this.isPartyChatVisible()) {
          this.partyChatUnread += 1;
        }
        this.cdr.detectChanges();
        queueMicrotask(() => this.scrollPartyChatToBottom());
      })
    );
  }

  private async tryRestoreWatchParty(): Promise<void> {
    const saved = this.watchPartyService.getSavedSession();
    const partyFromUrl = this.route.snapshot.queryParamMap.get('party');
    const inviteCode = partyFromUrl?.trim().toUpperCase() || '';

    // Already connected from a previous frame (SPA navigation) — keep peer, just sync media
    if (this.watchPartyService.isInParty) {
      this.showWatchPartyPanel = true;
      const live = this.watchPartyService.snapshot;
      if (live.roomCode) {
        this.joinRoomCode = live.roomCode;
      }
      if (saved?.displayName) {
        this.watchPartyName = saved.displayName;
      }
      // Host owns the room title; guests only update local session state
      this.syncWatchPartyMedia();
      return;
    }

    // Invite link for a different room wins over a stale session
    if (
      inviteCode &&
      saved &&
      saved.roomCode.toUpperCase() !== inviteCode
    ) {
      this.openJoinInviteModal(inviteCode);
      return;
    }

    if (saved) {
      this.showWatchPartyPanel = true;
      this.watchPartyName = saved.displayName || '';
      this.joinRoomCode = saved.roomCode;
      this.watchPartyMode = saved.role === 'host' ? 'create' : 'join';

      try {
        const restored = await this.watchPartyService.restoreSession();
        if (restored) {
          this.syncWatchPartyMedia();
        } else if (saved.role === 'guest') {
          // Host may still be reconnecting — show join modal so they can retry with a name
          this.openJoinInviteModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
        }
      } catch (error) {
        console.error('Failed to restore watch party:', error);
        if (saved.role === 'guest') {
          this.openJoinInviteModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
        }
      }
      return;
    }

    if (inviteCode) {
      this.openJoinInviteModal(inviteCode);
    }
  }

  private openJoinInviteModal(roomCode: string): void {
    this.joinRoomCode = roomCode.trim().toUpperCase();
    this.watchPartyMode = 'join';
    this.showJoinInviteModal = true;
    this.showWatchPartyPanel = false;
  }

  closeJoinInviteModal(): void {
    this.showJoinInviteModal = false;
  }

  private syncPartyQueryParam(roomCode: string): void {
    const current = this.route.snapshot.queryParamMap.get('party');
    if (current?.toUpperCase() === roomCode.toUpperCase()) {
      return;
    }
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { party: roomCode },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private syncWatchPartyMedia(): void {
    if (!this.title?.trim() || !this.id || !this.mediaType) {
      return;
    }
    // Guests keep local session media in sync after navigating to the host title,
    // but never broadcast (host is source of truth).
    this.watchPartyService.setMediaState({
      mediaType: this.mediaType,
      id: String(this.id),
      season: this.mediaType === 'tv' ? this.selectedSeason : undefined,
      episode: this.mediaType === 'tv' ? this.selectedEpisode : undefined,
      title: this.title,
      posterPath: this.posterPath,
    });
  }

  private broadcastWatchPartyEvent(
    event: 'play' | 'pause' | 'seeked',
    time: number
  ): void {
    if (Date.now() < this.ignorePartyBroadcastUntil) {
      return;
    }
    if (this.watchPartyService.isApplyingRemote) {
      return;
    }
    this.watchPartyService.broadcastPlayerEvent(event, time ?? this.currentTime);
  }

  toggleWatchPartyPanel(): void {
    this.showWatchPartyPanel = !this.showWatchPartyPanel;
    if (this.showWatchPartyPanel && this.showPartyChat && !this.isFullscreen) {
      this.partyChatUnread = 0;
    }
  }

  async startWatchParty(): Promise<void> {
    try {
      this.syncWatchPartyMedia();
      await this.watchPartyService.createParty(this.getWatchPartyDisplayName('Host'));
      // Ensure media is stored/broadcast now that the party is live
      this.syncWatchPartyMedia();
      this.showWatchPartyPanel = true;
    } catch (error) {
      console.error('Failed to start watch party:', error);
    }
  }

  async joinWatchParty(): Promise<void> {
    try {
      await this.watchPartyService.joinParty(
        this.joinRoomCode,
        this.getWatchPartyDisplayName('Guest')
      );
      this.showJoinInviteModal = false;
      this.showWatchPartyPanel = true;
      // Do not push the guest's current title — wait for the host media sync
    } catch (error) {
      console.error('Failed to join watch party:', error);
      // Keep invite modal open so the error + retry are visible on mobile
      this.showJoinInviteModal = true;
    } finally {
      this.cdr.detectChanges();
    }
  }

  leaveWatchParty(): void {
    this.watchPartyService.leaveParty();
    this.watchPartyCopied = false;
    this.partyChatMessages = [];
    this.partyChatDraft = '';
    this.partyChatUnread = 0;
    this.showFloatingPartyChat = false;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { party: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  sendPartyChat(): void {
    if (!this.watchParty.connected) {
      return;
    }
    const sent = this.watchPartyService.sendChat(this.partyChatDraft);
    if (sent) {
      this.partyChatDraft = '';
    }
  }

  togglePartyChat(): void {
    this.showPartyChat = !this.showPartyChat;
    if (this.showPartyChat) {
      this.partyChatUnread = 0;
      queueMicrotask(() => this.scrollPartyChatToBottom());
    }
  }

  toggleFloatingPartyChat(): void {
    this.showFloatingPartyChat = !this.showFloatingPartyChat;
    if (this.showFloatingPartyChat) {
      this.partyChatUnread = 0;
      queueMicrotask(() => this.scrollPartyChatToBottom());
    }
  }

  private isPartyChatVisible(): boolean {
    if (this.isFullscreen) {
      return this.showFloatingPartyChat;
    }
    return this.showWatchPartyPanel && this.showPartyChat;
  }

  formatChatTime(timestamp: number): string {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  trackPartyChat(_index: number, msg: WatchPartyChatMessage): string {
    return msg.id;
  }

  private scrollPartyChatToBottom(): void {
    const el = this.partyChatScroll?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Push your current time/play state to everyone (fixes drift). */
  syncWatchParty(): void {
    if (!this.watchParty.connected) {
      return;
    }
    this.watchPartyService.broadcastSync(this.currentTime, this.isPlaying);
  }

  async copyPartyInvite(): Promise<void> {
    const invite = this.watchParty.inviteUrl;
    if (!invite) {
      return;
    }

    try {
      await navigator.clipboard.writeText(invite);
      this.watchPartyCopied = true;
      setTimeout(() => {
        this.watchPartyCopied = false;
      }, 2000);
    } catch (error) {
      console.error('Failed to copy invite link:', error);
    }
  }

  private applyWatchPartyCommand(command: WatchPartyCommand): void {
    if (command.media) {
      this.ensureWatchPartyMedia(command.media);
    }

    if (command.action === 'media' || command.action === 'hello') {
      return;
    }

    const time = command.time ?? this.currentTime;

    this.watchPartyService.runAsRemote(() => {
      this.ignorePartyBroadcastUntil = Date.now() + 800;

      switch (command.action) {
        case 'play':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({ command: 'play', time });
          this.isPlaying = true;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'pause':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({ command: 'pause', time });
          this.isPlaying = false;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'seek':
          this.seekTo(time);
          break;
        case 'sync':
          this.postPlayerCommand({ command: 'seek', time });
          this.postPlayerCommand({
            command: command.playing ? 'play' : 'pause',
            time,
          });
          this.isPlaying = !!command.playing;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
      }
    });
  }

  private ensureWatchPartyMedia(media: {
    mediaType: string;
    id: string;
    season?: number;
    episode?: number;
  }): void {
    const sameTitle =
      media.mediaType === this.mediaType &&
      String(media.id) === String(this.id);

    if (sameTitle && media.mediaType === 'tv') {
      if (
        media.season != null &&
        media.season !== this.selectedSeason
      ) {
        this.selectedSeason = media.season;
        this.fetchEpisodes(media.season).add(() => {
          if (media.episode != null) {
            this.selectEpisode(media.episode);
          }
        });
        return;
      }

      if (
        media.episode != null &&
        media.episode !== this.selectedEpisode
      ) {
        this.selectEpisode(media.episode);
      }
      return;
    }

    if (sameTitle) {
      return;
    }

    // Different title — navigate and keep party code in the URL for rejoin
    const queryParams = this.watchParty.roomCode
      ? { party: this.watchParty.roomCode }
      : {};

    if (media.mediaType === 'tv' && media.season && media.episode) {
      this.router.navigate(
        ['/frame', media.mediaType, media.id, media.season, media.episode],
        { queryParams }
      );
    } else {
      this.router.navigate(['/frame', media.mediaType, media.id], { queryParams });
    }
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  prevEpisode(): void {
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex > 0) {
      this.selectEpisode(this.episodes[currentIndex - 1].episode_number);
    }
  }

  nextEpisode(): void {
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex < this.episodes.length - 1) {
      this.selectEpisode(this.episodes[currentIndex + 1].episode_number);
    }
  }

  scrollLeft(type: string): void {
    const container = type === 'seasons' ? this.seasonScroll.nativeElement : this.episodeScroll.nativeElement;
    container.scrollBy({ left: -200, behavior: 'smooth' }); // Scroll left by 200px
  }

  scrollRight(type: string): void {
    const container = type === 'seasons' ? this.seasonScroll.nativeElement : this.episodeScroll.nativeElement;
    container.scrollBy({ left: 200, behavior: 'smooth' }); // Scroll right by 200px
  }
}
