import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgForOf, NgIf, CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { inject } from '@vercel/analytics';
import Hls from 'hls.js';
import { environment, StreamProvider } from '../../../environments/environment';
import { WatchProgressService } from '../../services/watch-progress.service';
import { AuthService } from '../../services/auth.service';
import { ApiplayerStreamService } from '../../services/apiplayer-stream.service';
import { VidphantomStreamService } from '../../services/vidphantom-stream.service';
import { SubtitleCue, SubtitleService } from '../../services/subtitle.service';
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
type PlayerCommand = 'play' | 'pause' | 'seek' | 'getStatus';

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

interface ApiplayerMessage {
  type?: string;
  event?: string;
  action?: string;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  muted?: boolean;
  volume?: number;
  message?: string;
  position?: number;
  percent?: number;
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

  /** CinemaOS uses the same PLAYER_EVENT / { command } bridge as VidFast. */
  private readonly cinemaosOrigins = [
    'https://cinemaos.tech',
    'https://cinemaos.live',
    'https://cinemaos.me',
    'https://cinemaos-v3.vercel.app',
  ];

  /** VidPhantom docs: https://vidphantom.com/ */
  private readonly vidphantomOrigins = [
    'https://vidphantom.com',
    'https://www.vidphantom.com',
    'https://vidphantom.live',
    'https://vidphantom.online',
    'https://vidphantom.site',
    'https://vidphantom.website',
    'https://vidphantom.xyz',
  ];

  private readonly apiplayerOrigins = [
    'https://apiplayer.ru',
    'https://www.apiplayer.ru',
  ];

  private readonly onPlayerMessage = (event: MessageEvent): void => {
    this.handlePlayerMessage(event);
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

  // Custom player state (driven by provider postMessage events)
  isPlaying = false;
  currentTime = 0;
  duration = 0;
  isSeeking = false;
  /** Sticky seek target so CinemaOS can't snap the scrubber / stream back to 0. */
  private lastSeekTarget: number | null = null;
  private seekGuardUntil = 0;
  private seekRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SEEK_GUARD_MS = 5000;
  private static readonly SEEK_RETRY_MS = 350;
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

  // Subtitles / provider / server (URL params differ per embed host)
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
  readonly providerOptions: { id: StreamProvider; label: string }[] = [
    { id: 'apiplayer', label: 'ApiPlayer' },
    { id: 'cinemaos', label: 'CinemaOS' },
    { id: 'vidphantom', label: 'VidPhantom' },
    { id: 'vidfast', label: 'VidFast' },
  ];
  selectedProvider: StreamProvider =
    (environment as { streamProvider?: StreamProvider }).streamProvider || 'apiplayer';
  /** True after lowest-ping primary (+ VidFast #2) has been applied for this page. */
  private providerPriorityApplied = false;
  private providerPriorityPromise: Promise<void> | null = null;
  selectedSubtitle: string | null = null;
  /** Active cue text for CinemaOS (and ApiPlayer fallback) overlay. */
  activeSubtitleText = '';
  isSubtitleLoading = false;
  private subtitleCues: SubtitleCue[] = [];
  private subtitleVttUrl: string | null = null;
  private subtitleLoadToken = 0;
  private cachedImdbId: string | null = null;
  selectedServer: string = environment.streamServer || 'vEdge';
  /** When true, omit `server=` so VidFast can pick a working source itself. */
  useAutoServer = false;
  showCcMenu = false;
  showProviderMenu = false;
  showServerMenu = false;
  isPlayerReloading = false;
  playerReloadLabel = 'Loading…';
  /** True while the local HLS <video> surface should be mounted (ApiPlayer). */
  apiplayerSurfaceActive = false;
  private pendingSeekSeconds: number | null = null;
  private hlsPlayer: Hls | null = null;
  private apiplayerLoadToken = 0;

  /** Latency probe results for provider rows (ms). `null` = measuring / unknown. */
  providerPingMs: Record<StreamProvider, number | null> = {
    apiplayer: null,
    cinemaos: null,
    vidphantom: null,
    vidfast: null,
  };
  providerPingPending: Record<StreamProvider, boolean> = {
    apiplayer: false,
    cinemaos: false,
    vidphantom: false,
    vidfast: false,
  };
  private readonly providerPingUrls: Record<StreamProvider, string> = {
    apiplayer: 'https://apiplayer.ru/favicon.ico',
    cinemaos: 'https://cinemaos.tech/favicon.ico',
    vidphantom: 'https://vidphantom.com/favicon.ico',
    vidfast: 'https://vidfast.vc/favicon.ico',
  };
  private lastProviderPingAt = 0;

  /** Auto-failover: try next server if current one never starts playback. */
  private static readonly SERVER_FAILOVER_MS = 12000;
  private static readonly APIPLAYER_FAILOVER_MS = 8000;
  private static readonly AUTO_SERVER_ID = 'auto';
  private serverFailoverTimer: ReturnType<typeof setTimeout> | null = null;
  private serversTriedThisTitle = new Set<string>();
  private providersTriedThisTitle = new Set<StreamProvider>();
  private serverPlaybackOk = false;

  get isVidfastProvider(): boolean {
    return this.selectedProvider === 'vidfast';
  }

  get isCinemaosProvider(): boolean {
    return this.selectedProvider === 'cinemaos';
  }

  get isVidphantomProvider(): boolean {
    return this.selectedProvider === 'vidphantom';
  }

  get isApiplayerProvider(): boolean {
    return this.selectedProvider === 'apiplayer';
  }

  /** Embed hosts with a real subtitle query param (reload to apply). */
  get usesEmbedSubParam(): boolean {
    return this.isVidfastProvider;
  }

  /**
   * Local HLS + Luscreens controller.
   * ApiPlayer + VidPhantom (no inbound postMessage play/seek — play their HLS here).
   */
  get usesLocalHls(): boolean {
    return this.isApiplayerProvider || this.isVidphantomProvider;
  }

  /**
   * Iframe embeds that speak PLAYER_EVENT / { command }.
   * CinemaOS: https://cinemaos.tech/embed
   */
  get usesRemoteIframe(): boolean {
    return this.isVidfastProvider || this.isCinemaosProvider;
  }

  /** Player chrome is mounted for either embed provider. */
  get hasPlayerSurface(): boolean {
    return this.usesLocalHls || !!this.embedUrl;
  }

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

  get activeProviderLabel(): string {
    return this.providerOptions.find((p) => p.id === this.selectedProvider)?.label
      ?? this.selectedProvider;
  }

  get activeServerLabel(): string {
    if (this.isApiplayerProvider) {
      return this.activeProviderLabel;
    }
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
  watchPartyName = '';
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
  @ViewChild('playerVideo') playerVideo?: ElementRef<HTMLVideoElement>;
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
    private apiplayerStream: ApiplayerStreamService,
    private vidphantomStream: VidphantomStreamService,
    private subtitleService: SubtitleService,
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
    // Warm provider RTT so the first open can pick lowest-ping primary
    void this.refreshProviderPings(true);

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
    this.clearSeekGuard();
    this.clearSubtitles();
    this.apiplayerLoadToken++;
    this.subtitleLoadToken++;
    this.destroyApiplayerVideo();
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

        this.openPlayer();
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
      this.openPlayer();
      this.syncWatchPartyMedia();
    }
  }

  /** Mount local HLS (ApiPlayer / VidPhantom) or CinemaOS/VidFast iframe. */
  private openPlayer(resumeAt?: number): void {
    void this.openPlayerAsync(resumeAt);
  }

  private async openPlayerAsync(resumeAt?: number): Promise<void> {
    await this.ensureProviderPriority();

    if (this.usesLocalHls) {
      this.embedUrl = null;
      void this.loadLocalHlsVideo(resumeAt);
      return;
    }

    this.destroyApiplayerVideo();
    if (this.isCinemaosProvider) {
      this.embedUrl = this.buildCinemaosEmbedUrl(resumeAt);
      return;
    }

    const path = this.getEmbedPath();
    if (!path) {
      return;
    }
    this.embedUrl = this.buildVidfastEmbedUrl(path, resumeAt);
  }

  private resolveStartAt(resumeAt?: number): number {
    const cleared = this.watchProgress.isSuppressed(this.mediaType, this.id);
    if (cleared) {
      return 0;
    }
    if (resumeAt != null && resumeAt > 0) {
      return resumeAt;
    }
    return this.getSavedStartAt();
  }

  private buildEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    if (this.isCinemaosProvider) {
      return this.buildCinemaosEmbedUrl(resumeAt);
    }
    if (this.isApiplayerProvider || this.isVidphantomProvider) {
      return this.buildApiplayerEmbedUrl(path, resumeAt);
    }
    return this.buildVidfastEmbedUrl(path, resumeAt);
  }

  private buildCinemaosEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }

    const path =
      this.mediaType === 'tv'
        ? `player/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
        : `player/${this.id}`;

    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'e50914',
      showTitle: 'false',
      nextButton: this.mediaType === 'tv' ? 'true' : 'false',
      autoNext: this.mediaType === 'tv' ? 'true' : 'false',
    });

    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    if (startAt > 0) {
      params.set('startTime', String(startAt));
    }

    const url = `https://cinemaos.tech/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private buildVidfastEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
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

    const startAt = this.resolveStartAt(resumeAt);
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

  private buildApiplayerEmbedUrl(path: string, _resumeAt?: number): SafeResourceUrl {
    // Kept for reference / provider switch fallback; ApiPlayer plays via direct HLS.
    const params = new URLSearchParams({
      autoplay: '1',
      resume: '0',
    });
    if (this.selectedSubtitle) {
      params.set('lang', this.selectedSubtitle);
    }
    if (this.mediaType === 'tv') {
      params.set('autonext', '1');
    }
    const url = `https://apiplayer.ru/embed/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private async loadLocalHlsVideo(resumeAt?: number): Promise<void> {
    if (!this.id || !this.mediaType || !this.usesLocalHls) {
      return;
    }

    const provider = this.selectedProvider;
    const loadToken = ++this.apiplayerLoadToken;
    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.destroyApiplayerVideo(false);
    this.apiplayerSurfaceActive = true;
    this.cdr.detectChanges();

    try {
      const mediaType = this.mediaType === 'tv' ? 'tv' : 'movie';
      const season = this.mediaType === 'tv' ? this.selectedSeason : undefined;
      const episode = this.mediaType === 'tv' ? this.selectedEpisode : undefined;

      let masterUrl: string;
      if (provider === 'vidphantom') {
        const stream = await this.vidphantomStream.resolveStream({
          mediaType,
          id: this.id,
          season,
          episode,
        });
        masterUrl = stream.masterUrl;
      } else {
        const stream = await this.apiplayerStream.resolveStream({
          mediaType,
          id: this.id,
          season,
          episode,
        });
        if (stream.imdbId) {
          this.cachedImdbId = stream.imdbId;
        }
        masterUrl = stream.masterUrl;
      }

      if (loadToken !== this.apiplayerLoadToken || this.selectedProvider !== provider) {
        return;
      }

      await this.attachHlsToVideo(masterUrl, resumeAt);

      if (loadToken !== this.apiplayerLoadToken) {
        return;
      }

      this.isPlayerReloading = false;
      this.beginClearedBootstrapIfNeeded();
      this.armServerFailoverWatch();
      if (this.selectedSubtitle) {
        void this.applySubtitleSelection(this.selectedSubtitle, false);
      }
      this.cdr.detectChanges();
    } catch (error) {
      console.error(`${provider} stream failed:`, error);
      if (loadToken !== this.apiplayerLoadToken) {
        return;
      }
      this.providersTriedThisTitle.add(provider);
      const next = this.nextFailoverProvider(provider);
      if (next) {
        this.selectedProvider = next;
        if (next === 'vidfast') {
          this.useAutoServer = true;
        }
        this.reloadPlayer(
          resumeAt ?? this.currentTime,
          `Trying ${this.activeProviderLabel}…`
        );
        return;
      }
      this.showNoServerFound();
    }
  }

  /**
   * Priority: #1 lowest-ping (non-VidFast), #2 VidFast, then remaining by ping.
   * Failed / unknown pings sort last.
   */
  private getProviderFailoverOrder(): StreamProvider[] {
    const others: StreamProvider[] = ['apiplayer', 'cinemaos', 'vidphantom'];
    const ranked = [...others].sort((a, b) => {
      const am =
        this.providerPingMs[a] == null || this.providerPingMs[a]! < 0
          ? Number.POSITIVE_INFINITY
          : this.providerPingMs[a]!;
      const bm =
        this.providerPingMs[b] == null || this.providerPingMs[b]! < 0
          ? Number.POSITIVE_INFINITY
          : this.providerPingMs[b]!;
      return am - bm;
    });
    const primary = ranked[0] ?? 'apiplayer';
    return [primary, 'vidfast', ...ranked.filter((id) => id !== primary)];
  }

  /** Pick primary once from current pings (does not override manual choice). */
  private ensureProviderPriority(): Promise<void> {
    if (!this.providerPriorityPromise) {
      this.providerPriorityPromise = this.resolveProviderPriority();
    }
    return this.providerPriorityPromise;
  }

  private async resolveProviderPriority(): Promise<void> {
    await this.refreshProviderPings(true);
    if (this.providerPriorityApplied) {
      return;
    }
    this.providerPriorityApplied = true;
    this.selectedProvider = this.getProviderFailoverOrder()[0] ?? 'apiplayer';
    this.cdr.detectChanges();
  }

  private nextFailoverProvider(from: StreamProvider): StreamProvider | null {
    const order = this.getProviderFailoverOrder();
    const start = Math.max(0, order.indexOf(from));
    for (let i = 1; i < order.length; i++) {
      const candidate = order[(start + i) % order.length];
      if (!this.providersTriedThisTitle.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private attachHlsToVideo(masterUrl: string, resumeAt?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryAttach = (attempt: number): void => {
        const video = this.playerVideo?.nativeElement;
        if (!video) {
          if (attempt < 10) {
            setTimeout(() => tryAttach(attempt + 1), 50);
            return;
          }
          reject(new Error('Video element not ready'));
          return;
        }

        const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
        const onReady = (): void => {
          if (startAt > 5) {
            video.currentTime = startAt;
          }
          void video.play().catch(() => {
            // Autoplay may be blocked until the user taps — controller still works.
          });
          resolve();
        };

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
          });
          this.hlsPlayer = hls;
          hls.loadSource(masterUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => onReady());
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              reject(data);
            }
          });
          return;
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = masterUrl;
          video.addEventListener('loadedmetadata', () => onReady(), { once: true });
          video.addEventListener('error', () => reject(new Error('Native HLS failed')), {
            once: true,
          });
          return;
        }

        reject(new Error('HLS is not supported in this browser'));
      };

      tryAttach(0);
    });
  }

  private destroyApiplayerVideo(clearSurface = true): void {
    if (this.hlsPlayer) {
      this.hlsPlayer.destroy();
      this.hlsPlayer = null;
    }
    const video = this.playerVideo?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (clearSurface) {
      this.apiplayerSurfaceActive = false;
    }
  }

  onVideoPlay(): void {
    this.onPlayerEvent({
      event: 'play',
      currentTime: this.playerVideo?.nativeElement.currentTime ?? this.currentTime,
      duration: this.playerVideo?.nativeElement.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: true,
      muted: !!this.playerVideo?.nativeElement.muted,
      volume: this.playerVideo?.nativeElement.volume ?? 1,
    });
  }

  onVideoPause(): void {
    this.onPlayerEvent({
      event: 'pause',
      currentTime: this.playerVideo?.nativeElement.currentTime ?? this.currentTime,
      duration: this.playerVideo?.nativeElement.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: false,
      muted: !!this.playerVideo?.nativeElement.muted,
      volume: this.playerVideo?.nativeElement.volume ?? 1,
    });
  }

  onVideoTimeUpdate(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.onPlayerEvent({
      event: 'timeupdate',
      currentTime: video.currentTime,
      duration: video.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: !video.paused,
      muted: video.muted,
      volume: video.volume,
    });
  }

  onVideoSeeked(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.onPlayerEvent({
      event: 'seeked',
      currentTime: video.currentTime,
      duration: video.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: !video.paused,
      muted: video.muted,
      volume: video.volume,
    });
  }

  onVideoEnded(): void {
    const video = this.playerVideo?.nativeElement;
    this.onPlayerEvent({
      event: 'ended',
      currentTime: video?.currentTime ?? this.currentTime,
      duration: video?.duration || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing: false,
      muted: !!video?.muted,
      volume: video?.volume ?? 1,
    });
  }

  onVideoLoadedMetadata(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    this.duration = Number.isFinite(video.duration) ? video.duration : this.duration;
    this.markServerPlaybackOk();
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
    const time = resumeAt ?? this.currentTime;
    this.playerReloadLabel = label;
    this.isPlayerReloading = true;

    if (this.usesLocalHls) {
      void this.loadLocalHlsVideo(time > 5 ? time : undefined);
      return;
    }

    this.destroyApiplayerVideo();
    // Keep previous frame painted under the overlay; swap src on next tick
    setTimeout(() => {
      this.openPlayer(time > 5 ? time : undefined);
      // openPlayer clears reloading only via iframe load / HLS path
      if (this.usesRemoteIframe) {
        // iframe (load) handler clears the overlay
      }
    }, 50);
  }

  onPlayerIframeLoad(): void {
    this.isPlayerReloading = false;
    this.beginClearedBootstrapIfNeeded();
    this.requestPlayerStatus();
    this.armServerFailoverWatch();
    // CinemaOS autoPlay starts muted (browser policy) — unmute once the embed is ready
    if (this.isCinemaosProvider) {
      setTimeout(() => this.unmuteRemotePlayer(), 400);
      setTimeout(() => this.unmuteRemotePlayer(), 1200);
    }
    if (this.selectedSubtitle && !this.usesEmbedSubParam) {
      void this.applySubtitleSelection(this.selectedSubtitle, false);
    }
  }

  toggleCcMenu(): void {
    this.showCcMenu = !this.showCcMenu;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.revealPlayerControls();
  }

  toggleProviderMenu(): void {
    this.showProviderMenu = !this.showProviderMenu;
    this.showServerMenu = false;
    this.showCcMenu = false;
    this.revealPlayerControls();
    if (this.showProviderMenu) {
      void this.refreshProviderPings();
    }
  }

  toggleServerMenu(): void {
    if (!this.isVidfastProvider) {
      return;
    }
    this.showServerMenu = !this.showServerMenu;
    this.showProviderMenu = false;
    this.showCcMenu = false;
    this.revealPlayerControls();
  }

  /** 0–4 bars from RTT; 0 = error / unknown while idle. */
  getProviderSignalLevel(provider: StreamProvider): number {
    if (this.providerPingPending[provider]) {
      return -1;
    }
    const ms = this.providerPingMs[provider];
    if (ms == null || ms < 0) {
      return 0;
    }
    if (ms < 120) {
      return 4;
    }
    if (ms < 250) {
      return 3;
    }
    if (ms < 450) {
      return 2;
    }
    return 1;
  }

  formatProviderPing(provider: StreamProvider): string {
    if (this.providerPingPending[provider]) {
      return '…';
    }
    const ms = this.providerPingMs[provider];
    if (ms == null) {
      return '—';
    }
    if (ms < 0) {
      return 'fail';
    }
    return `${ms}ms`;
  }

  providerPingTone(provider: StreamProvider): string {
    const level = this.getProviderSignalLevel(provider);
    if (level >= 4) {
      return 'text-emerald-400';
    }
    if (level === 3) {
      return 'text-lime-400';
    }
    if (level === 2) {
      return 'text-amber-400';
    }
    if (level === 1) {
      return 'text-orange-400';
    }
    if (level === -1) {
      return 'text-white/40';
    }
    return 'text-red-400';
  }

  private async refreshProviderPings(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastProviderPingAt < 8000) {
      // Still refresh UI if we have nothing yet
      const missing = this.providerOptions.some(
        (p) => this.providerPingMs[p.id] == null && !this.providerPingPending[p.id]
      );
      if (!missing) {
        return;
      }
    }
    this.lastProviderPingAt = now;

    await Promise.all(
      this.providerOptions.map((provider) => this.pingProvider(provider.id))
    );
    this.cdr.detectChanges();
  }

  private async pingProvider(provider: StreamProvider): Promise<void> {
    this.providerPingPending[provider] = true;
    this.cdr.detectChanges();

    const url = `${this.providerPingUrls[provider]}?_=${Date.now()}`;
    const started = performance.now();
    let ms = -1;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      ms = Math.max(1, Math.round(performance.now() - started));
    } catch {
      // Abort / network error — still record elapsed if the attempt ran briefly
      const elapsed = Math.round(performance.now() - started);
      ms = elapsed > 50 ? elapsed : -1;
    }

    this.providerPingMs[provider] = ms;
    this.providerPingPending[provider] = false;
  }

  selectSubtitle(code: string | null): void {
    if (this.selectedSubtitle === code) {
      this.showCcMenu = false;
      return;
    }
    this.selectedSubtitle = code;
    this.showCcMenu = false;

    // VidFast (`sub=`) — soft-reload; clear our overlay so it doesn't stack on embed CC.
    if (this.usesEmbedSubParam) {
      this.clearSubtitles(false);
      this.reloadPlayer(
        this.currentTime,
        code ? 'Applying subtitles…' : 'Turning off subtitles…'
      );
      return;
    }

    // ApiPlayer / VidPhantom / CinemaOS: load cues ourselves (overlay only).
    void this.applySubtitleSelection(code);
  }

  /** Scrubber max — never 0 or the range input can only seek to 0. */
  get seekBarMax(): number {
    if (this.duration > 1) {
      return this.duration;
    }
    return Math.max(this.currentTime + 600, 7200);
  }

  selectProvider(provider: StreamProvider): void {
    if (this.selectedProvider === provider) {
      this.showProviderMenu = false;
      return;
    }
    this.providerPriorityApplied = true; // keep manual choice
    this.selectedProvider = provider;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.resetServerFailoverState();
    // VidFast owns CC via `sub=` — drop our cue overlay so it doesn't double up
    if (this.usesEmbedSubParam) {
      this.clearSubtitles(false);
    }
    this.reloadPlayer(
      this.currentTime,
      `Switching to ${this.activeProviderLabel}…`
    );
  }

  selectServer(server: string): void {
    if (!this.isVidfastProvider) {
      this.showServerMenu = false;
      return;
    }
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
    this.providersTriedThisTitle.clear();
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

    this.providersTriedThisTitle.add(this.selectedProvider);

    // HLS / CinemaOS / VidPhantom: if playback never starts, try the next provider
    if (this.usesLocalHls || this.isCinemaosProvider) {
      this.serverFailoverTimer = setTimeout(() => {
        if (this.serverPlaybackOk || this.isPlayerReloading) {
          return;
        }
        const next = this.nextFailoverProvider(this.selectedProvider);
        if (!next) {
          this.showNoServerFound();
          return;
        }
        this.selectedProvider = next;
        if (next === 'vidfast') {
          this.useAutoServer = true;
        }
        this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
      }, FrameComponent.APIPLAYER_FAILOVER_MS);
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

  private showNoServerFound(): void {
    this.playerReloadLabel = 'No working server found';
    this.isPlayerReloading = true;
    setTimeout(() => {
      if (!this.serverPlaybackOk) {
        this.isPlayerReloading = false;
        this.cdr.detectChanges();
      }
    }, 2500);
  }

  /** Current VidFast server never started — try next pin, then Auto. Do not bounce to ApiPlayer. */
  private tryNextServerFailover(): void {
    if (this.serverPlaybackOk || this.isPlayerReloading) {
      return;
    }

    if (!this.isVidfastProvider) {
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

    this.showNoServerFound();
  }

  private resetPlayerState(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.clearSeekGuard();
    this.clearSubtitles();
    this.cachedImdbId = null;
    this.beginClearedBootstrapIfNeeded();
  }

  private async applySubtitleSelection(
    code: string | null,
    showOverlay = true
  ): Promise<void> {
    const loadToken = ++this.subtitleLoadToken;
    this.clearSubtitles(false);

    if (!code) {
      this.isSubtitleLoading = false;
      this.cdr.detectChanges();
      return;
    }

    if (showOverlay) {
      this.playerReloadLabel = 'Loading subtitles…';
      this.isPlayerReloading = true;
    }
    this.isSubtitleLoading = true;
    this.cdr.detectChanges();

    try {
      const imdbId = await this.subtitleService.resolveImdbId({
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        tmdbId: this.id,
        tmdbApiKey: environment.tmdbApiKey,
        fallbackImdbId: this.cachedImdbId,
      });

      if (loadToken !== this.subtitleLoadToken) {
        return;
      }
      if (!imdbId) {
        throw new Error('No IMDb id for subtitles');
      }
      this.cachedImdbId = imdbId;

      const loaded = await this.subtitleService.loadCues({
        imdbId,
        lang: code,
        season: this.mediaType === 'tv' ? this.selectedSeason : undefined,
        episode: this.mediaType === 'tv' ? this.selectedEpisode : undefined,
      });

      if (loadToken !== this.subtitleLoadToken) {
        return;
      }
      if (!loaded) {
        throw new Error('No subtitles found');
      }

      this.subtitleCues = loaded.cues;
      this.subtitleVttUrl = loaded.vttUrl;
      // Overlay only — never enable native <track> (that stacked a second cue on screen)
      this.removeNativeSubtitleTracks();
      this.syncSubtitleOverlay();
    } catch (error) {
      console.error('Subtitle load failed:', error);
      if (loadToken === this.subtitleLoadToken) {
        this.selectedSubtitle = null;
        this.clearSubtitles(false);
      }
    } finally {
      if (loadToken === this.subtitleLoadToken) {
        this.isSubtitleLoading = false;
        if (showOverlay) {
          this.isPlayerReloading = false;
        }
        this.cdr.detectChanges();
      }
    }
  }

  private removeNativeSubtitleTracks(): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }
    Array.from(video.querySelectorAll('track[data-luscreens-sub="1"]')).forEach((el) => {
      el.remove();
    });
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (track.kind === 'subtitles' || track.kind === 'captions') {
        track.mode = 'disabled';
      }
    }
  }

  private syncSubtitleOverlay(): void {
    // VidFast uses embed `sub=` — never draw our overlay on top of theirs
    if (this.usesEmbedSubParam || !this.selectedSubtitle || this.subtitleCues.length === 0) {
      if (this.activeSubtitleText) {
        this.activeSubtitleText = '';
      }
      return;
    }
    this.activeSubtitleText = this.subtitleService.findActiveCueText(
      this.subtitleCues,
      this.currentTime
    );
  }

  private clearSubtitles(_keepSelection = true): void {
    this.activeSubtitleText = '';
    this.subtitleCues = [];
    this.subtitleService.revokeUrl(this.subtitleVttUrl);
    this.subtitleVttUrl = null;
    this.removeNativeSubtitleTracks();
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

  private handlePlayerMessage(event: MessageEvent): void {
    if (!event.data) {
      return;
    }

    const type = String(event.data?.type || '');

    // Live ApiPlayer build emits player:* / ended (docs' mplayer inbound API is not shipped)
    if (
      type === 'mplayer' ||
      type === 'player:timeupdate' ||
      type === 'player:play' ||
      type === 'player:pause' ||
      type === 'ended' ||
      type.startsWith('player:')
    ) {
      this.handleApiplayerMessage(event);
      return;
    }

    this.handleRemoteIframeMessage(event);
  }

  private isVidfastOrigin(origin: string): boolean {
    return this.vidfastOrigins.includes(origin) || /vidfast\./i.test(origin || '');
  }

  private isCinemaosOrigin(origin: string): boolean {
    return this.cinemaosOrigins.includes(origin) || /cinemaos\./i.test(origin || '');
  }

  private isVidphantomOrigin(origin: string): boolean {
    return this.vidphantomOrigins.includes(origin) || /vidphantom\./i.test(origin || '');
  }

  private isRemoteIframeOrigin(origin: string): boolean {
    return (
      this.isVidfastOrigin(origin) ||
      this.isCinemaosOrigin(origin) ||
      this.isVidphantomOrigin(origin)
    );
  }

  private isApiplayerOrigin(origin: string): boolean {
    return this.apiplayerOrigins.includes(origin) || /apiplayer\./i.test(origin || '');
  }

  private handleApiplayerMessage(event: MessageEvent): void {
    if (event.origin && !this.isApiplayerOrigin(event.origin)) {
      return;
    }

    const payload = event.data as ApiplayerMessage;
    const type = String(payload?.type || '').toLowerCase();

    // Documented mplayer envelope (if a future build ships it)
    if (type === 'mplayer') {
      this.handleApiplayerMplayerEnvelope(payload);
      return;
    }

    // Shipped player.min.js outbound events
    if (type === 'player:timeupdate') {
      this.onPlayerEvent({
        event: 'timeupdate',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: true,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'player:play') {
      this.onPlayerEvent({
        event: 'play',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: true,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'player:pause') {
      this.onPlayerEvent({
        event: 'pause',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: false,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'ended') {
      this.onPlayerEvent({
        event: 'ended',
        currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
        duration: Number(payload.duration ?? this.duration) || this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: false,
        muted: false,
        volume: 1,
      });
    }
  }

  private handleApiplayerMplayerEnvelope(payload: ApiplayerMessage): void {
    const eventName = String(payload.event || '').toLowerCase();

    if (eventName === 'error') {
      if (this.usesLocalHls && !this.serverPlaybackOk) {
        const failed = this.selectedProvider;
        const next = this.nextFailoverProvider(failed);
        if (next) {
          this.providersTriedThisTitle.add(failed);
          this.selectedProvider = next;
          if (next === 'vidfast') {
            this.useAutoServer = true;
          }
          this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
        }
      }
      return;
    }

    const playing =
      eventName === 'play'
        ? true
        : eventName === 'pause' || eventName === 'ended'
          ? false
          : payload.paused === false
            ? true
            : this.isPlaying;

    const mappedEvent: PlayerEventName =
      eventName === 'play' ||
      eventName === 'pause' ||
      eventName === 'ended' ||
      eventName === 'timeupdate'
        ? eventName
        : 'playerstatus';

    this.onPlayerEvent({
      event: mappedEvent,
      currentTime: Number(payload.currentTime ?? this.currentTime) || this.currentTime,
      duration: Number(payload.duration ?? this.duration) || this.duration,
      tmdbId: +this.id || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: this.selectedSeason,
      episode: this.selectedEpisode,
      playing,
      muted: !!payload.muted,
      volume: Number(payload.volume ?? 1),
    });
  }

  private handleRemoteIframeMessage(event: MessageEvent): void {
    // VidFast + CinemaOS + VidPhantom share PLAYER_EVENT
    if (!this.isRemoteIframeOrigin(event.origin || '')) {
      return;
    }

    const payload = event.data;
    const type = payload?.type || payload?.eventType;
    const data = payload?.data ?? payload?.payload ?? payload;

    if (type === 'PLAYER_EVENT' && data) {
      const eventData = { ...(data as PlayerEventData) };
      // VidPhantom omits `playing` — derive it from the event name
      if (typeof eventData.playing !== 'boolean') {
        const name = String(eventData.event || '').toLowerCase();
        if (name === 'play') {
          eventData.playing = true;
        } else if (name === 'pause' || name === 'ended') {
          eventData.playing = false;
        }
      }
      this.onPlayerEvent(eventData);
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      // Ignore embed progress maps — PLAYER_EVENT upsertPlayback is our source.
      return;
    }

    // VidPhantom next-episode hook (when nextbutton=true)
    if (type === 'PLAYER_NEXT_EPISODE') {
      this.nextEpisode();
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
    const reportedTime = Number(data.currentTime);
    const hasReportedTime = Number.isFinite(reportedTime);
    const now = Date.now();
    const seekGuardActive =
      this.lastSeekTarget != null && now < this.seekGuardUntil;

    if (seekGuardActive && hasReportedTime) {
      this.handleSeekGuardUpdate(reportedTime, data.event);
    } else if (!this.isSeeking || data.event === 'seeked') {
      if (hasReportedTime) {
        // Keep prior time when embed briefly reports 0 after a real seek.
        if (!(reportedTime < 1 && this.currentTime > 8 && data.event !== 'seeked')) {
          this.currentTime = reportedTime;
        }
      }
    }

    const reportedDuration = Number(data.duration);
    if (Number.isFinite(reportedDuration) && reportedDuration > 1) {
      this.duration = reportedDuration;
    }
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
        // CinemaOS forces muted=true on autoPlay — lift it as soon as playback starts
        if (this.isCinemaosProvider) {
          this.unmuteRemotePlayer();
        }
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
        this.clearSeekGuard();
        this.persistLocalProgress(true);
        break;
      case 'seeked':
        if (
          this.lastSeekTarget == null ||
          Math.abs((hasReportedTime ? reportedTime : this.currentTime) - this.lastSeekTarget) <= 2.5
        ) {
          this.clearSeekGuard();
        }
        this.broadcastWatchPartyEvent('seeked', this.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'timeupdate':
        this.syncSubtitleOverlay();
        this.persistLocalProgress(false);
        break;
      case 'playerstatus':
        this.syncSubtitleOverlay();
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

  private handleSeekGuardUpdate(reportedTime: number, event?: string): void {
    const target = this.lastSeekTarget ?? this.currentTime;
    const delta = Math.abs(reportedTime - target);

    if (delta <= 1.75) {
      this.currentTime = reportedTime;
      this.clearSeekGuard();
      return;
    }

    // Hold UI on the scrub target while the embed catches up / fights us.
    this.currentTime = target;
    this.isSeeking = true;

    // CinemaOS sometimes ignores the first seek or snaps to 0 — re-issue.
    const snappedToStart = reportedTime < 1.5 && target > 5;
    const drifted = delta > 3;
    if ((snappedToStart || drifted) && (event === 'timeupdate' || event === 'seeked' || event === 'playerstatus')) {
      this.scheduleSeekRetry(target);
    }
  }

  private scheduleSeekRetry(target: number): void {
    if (this.seekRetryTimer != null) {
      return;
    }
    this.seekRetryTimer = setTimeout(() => {
      this.seekRetryTimer = null;
      if (this.lastSeekTarget == null || Date.now() > this.seekGuardUntil) {
        return;
      }
      this.postPlayerCommand('seek', target);
    }, FrameComponent.SEEK_RETRY_MS);
  }

  private clearSeekGuard(): void {
    this.isSeeking = false;
    this.lastSeekTarget = null;
    this.seekGuardUntil = 0;
    if (this.seekRetryTimer != null) {
      clearTimeout(this.seekRetryTimer);
      this.seekRetryTimer = null;
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
    this.postPlayerCommand('seek', 0);
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

  /**
   * Same Luscreens controller for every provider:
   * - ApiPlayer / VidPhantom → direct <video> / HLS commands
   * - CinemaOS / VidFast → iframe postMessage `{ command }` (PLAYER_EVENT bridge)
   */
  private postPlayerCommand(command: PlayerCommand, time?: number): void {
    if (this.usesLocalHls) {
      this.controlApiplayerVideo(command, time);
      return;
    }

    const contentWindow = this.playerIframe?.nativeElement?.contentWindow;
    if (!contentWindow) {
      return;
    }

    // CinemaOS: unmute before play (autoPlay path always starts muted)
    if (command === 'play' && this.isCinemaosProvider) {
      this.unmuteRemotePlayer();
    }

    contentWindow.postMessage(this.toRemoteIframeCommand(command, time), '*');
  }

  /**
   * CinemaOS postMessage API: `{ command: 'mute'|'volume', muted?, level? }`.
   * Volume scale is 0.0–1.0 (1 = 100% / max). AutoPlay starts muted — clear that and max volume.
   * https://cinemaos.tech/embed
   */
  private unmuteRemotePlayer(): void {
    if (!this.isCinemaosProvider) {
      return;
    }
    const contentWindow = this.playerIframe?.nativeElement?.contentWindow;
    if (!contentWindow) {
      return;
    }
    const maxVolume = 1; // docs: 0.0–1.0; 1 = 100%
    contentWindow.postMessage({ command: 'mute', muted: false }, '*');
    contentWindow.postMessage({ command: 'volume', level: maxVolume }, '*');
    // Re-assert after autoPlay mute race
    setTimeout(() => {
      const win = this.playerIframe?.nativeElement?.contentWindow;
      if (!win || !this.isCinemaosProvider) {
        return;
      }
      win.postMessage({ command: 'mute', muted: false }, '*');
      win.postMessage({ command: 'volume', level: maxVolume }, '*');
    }, 150);
  }

  private controlApiplayerVideo(command: PlayerCommand, time?: number): void {
    const video = this.playerVideo?.nativeElement;
    if (!video) {
      return;
    }

    switch (command) {
      case 'play':
        void video.play().catch(() => undefined);
        break;
      case 'pause':
        video.pause();
        break;
      case 'seek':
        video.currentTime = Math.max(0, time ?? this.currentTime);
        break;
      case 'getStatus':
        this.onPlayerEvent({
          event: 'playerstatus',
          currentTime: video.currentTime,
          duration: video.duration || this.duration,
          tmdbId: +this.id || 0,
          mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
          season: this.selectedSeason,
          episode: this.selectedEpisode,
          playing: !video.paused,
          muted: video.muted,
          volume: video.volume,
        });
        break;
    }
  }

  private toRemoteIframeCommand(
    command: PlayerCommand,
    time?: number
  ): Record<string, unknown> {
    if (command === 'seek') {
      return { command: 'seek', time: time ?? this.currentTime };
    }
    if (command === 'getStatus') {
      return { command: 'getStatus' };
    }
    return { command, ...(time != null ? { time } : {}) };
  }

  togglePlayPause(): void {
    this.postPlayerCommand(this.isPlaying ? 'pause' : 'play');
    // Optimistic UI so controls don't hide before the player event arrives
    this.isPlaying = !this.isPlaying;
    this.onPlaybackStateChanged();
  }

  get seekProgressPercent(): string {
    const max = this.seekBarMax;
    if (!max || max <= 0) {
      return '0%';
    }
    const pct = Math.min(100, Math.max(0, (this.currentTime / max) * 100));
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
    if (!this.isPlaying || this.showCcMenu || this.showProviderMenu || this.showServerMenu) {
      return;
    }
    this.controlsHideTimer = setTimeout(() => {
      if (
        this.isPlaying &&
        !this.showCcMenu &&
        !this.showProviderMenu &&
        !this.showServerMenu
      ) {
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
    const max = this.duration > 1 ? this.duration : Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(time, max));
    // Ignore accidental 0 seeks from a range input before duration is known
    if (clamped < 0.5 && this.currentTime > 8 && this.duration <= 1) {
      return;
    }
    this.isSeeking = true;
    this.clearedSessionReady = true; // user took control — never snap seek back to 0
    this.lastSeekTarget = clamped;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.currentTime = clamped;
    this.postPlayerCommand('seek', clamped);
    // CinemaOS may miss the first postMessage before the video element is ready
    if (this.isCinemaosProvider) {
      this.scheduleSeekRetry(clamped);
      setTimeout(() => this.postPlayerCommand('seek', clamped), 700);
    }
  }

  onSeekInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.isSeeking = true;
    this.clearedSessionReady = true;
    this.lastSeekTarget = value;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.currentTime = value;
    this.syncSubtitleOverlay();
  }

  onSeekChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.seekTo(value);
  }

  skipBy(seconds: number): void {
    this.seekTo(this.currentTime + seconds);
  }

  requestPlayerStatus(): void {
    this.postPlayerCommand('getStatus');
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
      this.watchPartyService.openJoinModal(inviteCode);
      this.showWatchPartyPanel = false;
      return;
    }

    if (saved) {
      this.showWatchPartyPanel = true;
      this.watchPartyName = saved.displayName || '';

      try {
        const restored = await this.watchPartyService.restoreSession();
        if (restored) {
          this.syncWatchPartyMedia();
        } else if (saved.role === 'guest') {
          // Host may still be reconnecting — open header join modal to retry
          this.watchPartyService.openJoinModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
          this.showWatchPartyPanel = false;
        }
      } catch (error) {
        console.error('Failed to restore watch party:', error);
        if (saved.role === 'guest') {
          this.watchPartyService.openJoinModal(saved.roomCode);
          this.watchPartyName = saved.displayName || '';
          this.showWatchPartyPanel = false;
        }
      }
      return;
    }

    if (inviteCode) {
      this.watchPartyService.openJoinModal(inviteCode);
      this.showWatchPartyPanel = false;
    }
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
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand('play', time);
          this.isPlaying = true;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'pause':
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand('pause', time);
          this.isPlaying = false;
          this.currentTime = time;
          this.onPlaybackStateChanged();
          break;
        case 'seek':
          this.seekTo(time);
          break;
        case 'sync':
          this.postPlayerCommand('seek', time);
          this.postPlayerCommand(command.playing ? 'play' : 'pause', time);
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
