import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
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
import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

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

  /** https://peachify.pro/ → embed host peachify.top */
  private readonly peachifyOrigins = [
    'https://peachify.top',
    'https://www.peachify.top',
    'https://peachify.pro',
    'https://www.peachify.pro',
  ];

  /** https://vidup.to/ — VidFast-style PLAYER_EVENT bridge */
  private readonly vidupOrigins = [
    'https://vidup.to',
    'https://www.vidup.to',
  ];

  /** https://www.videasy.to/docs → player.videasy.net */
  private readonly videasyOrigins = [
    'https://player.videasy.net',
    'https://videasy.net',
    'https://www.videasy.net',
    'https://videasy.to',
    'https://www.videasy.to',
  ];

  /** 111Movies iframe embed — listen for PLAYER_EVENT / progress postMessage. */
  private readonly movies111Origins = [
    'https://111movies.net',
    'https://www.111movies.net',
    'https://111movies.com',
    'https://www.111movies.com',
    'https://player.vidlove.cc',
    'https://vidlove.cc',
    'https://www.vidlove.cc',
  ];

  private readonly onPlayerMessage = (event: MessageEvent): void => {
    // postMessage can arrive outside Angular; keep scrubber / play state in sync
    this.ngZone.run(() => this.handlePlayerMessage(event));
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
  /** Ignore surface toggle briefly after hide / hover-reveal (avoids double-toggle). */
  private controlsToggleSuppressedUntil = 0;
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
  readonly providerOptions: { id: StreamProvider; label: string; recommended?: boolean }[] = [
    { id: 'movies111', label: 'Kean', recommended: true },
    { id: 'apiplayer', label: 'ApiPlayer' },
    { id: 'vidfast', label: 'VidFast' },
    { id: 'cinemaos', label: 'CinemaOS' },
    { id: 'vidphantom', label: 'VidPhantom' },
    { id: 'peachify', label: 'Peachify' },
    { id: 'vidup', label: 'VidUP' },
    { id: 'videasy', label: 'Videasy' },
  ];
  selectedProvider: StreamProvider =
    (environment as { streamProvider?: StreamProvider }).streamProvider || 'movies111';
  /** True after primary provider has been applied for this page. */
  private providerPriorityApplied = false;
  /** User picked a provider in the menu — do not auto-hop to another. */
  private providerLockedByUser = false;
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
  /** When true, omit `server=` so the embed can pick a working source itself. */
  useAutoServer = false;
  showCcMenu = false;
  showProviderMenu = false;
  showServerMenu = false;
  isPlayerReloading = false;
  playerReloadLabel = 'Loading…';
  private reloadOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cap full-screen reload splash so server/provider switches don't feel stuck. */
  private static readonly RELOAD_OVERLAY_MAX_MS = 2200;
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
    peachify: null,
    vidup: null,
    videasy: null,
    movies111: null,
  };
  providerPingPending: Record<StreamProvider, boolean> = {
    apiplayer: false,
    cinemaos: false,
    vidphantom: false,
    vidfast: false,
    peachify: false,
    vidup: false,
    videasy: false,
    movies111: false,
  };
  private readonly providerPingUrls: Record<StreamProvider, string> = {
    apiplayer: 'https://apiplayer.ru/favicon.ico',
    cinemaos: 'https://cinemaos.tech/favicon.ico',
    vidphantom: 'https://vidphantom.com/favicon.ico',
    vidfast: 'https://vidfast.vc/favicon.ico',
    peachify: 'https://peachify.top/favicon.ico',
    vidup: 'https://vidup.to/favicon.ico',
    videasy: 'https://player.videasy.net/favicon.ico',
    movies111: 'https://player.vidlove.cc/favicon.ico',
  };
  private lastProviderPingAt = 0;

  /**
   * Peachify disables parent→player postMessage commands.
   * Play/pause/seek are applied by rebuilding the embed URL (`autoPlay` + `startAt`).
   */
  private peachifyWantAutoPlay = true;
  private peachifyControlTimer: ReturnType<typeof setTimeout> | null = null;
  private peachifyRemountTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Keep `#playerContainer` in the DOM while embedUrl is briefly cleared.
   * Otherwise *ngIf tears down the fullscreen element on server/provider remount.
   */
  private playerSurfaceLocked = false;
  /** Bust iframe cache so autoPlay true/false always remounts. */
  private peachifyEmbedNonce = 0;
  /** Ignore outbound play/pause events while our URL control settles. */
  private peachifyIgnorePlayingUntil = 0;

  /**
   * Kean / Vidlove — never use autoplay=true (player forces mute).
   * Play = tap-through to Vidlove's unmuted play(); pause = remount; seek = SET_TIME.
   */
  private movies111WantAutoPlay = false;
  private movies111EmbedNonce = 0;
  private movies111IgnorePlayingUntil = 0;
  private movies111PendingSetTime: number | null = null;
  private movies111ControlTimer: ReturnType<typeof setTimeout> | null = null;
  private movies111RemountTimer: ReturnType<typeof setTimeout> | null = null;
  private movies111SetTimeTimers: ReturnType<typeof setTimeout>[] = [];
  /** Let clicks reach the iframe so Vidlove can start unmuted playback. */
  keanAwaitingGesturePlay = false;
  /** Full Luscreens splash over Kean until Vidlove finishes its own boot UI. */
  keanBootCover = false;
  private keanBootClearTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly KEAN_BOOT_COVER_MS = 3000;

  /**
   * Kean: let the Vidlove iframe receive taps for unmuted play.
   * Only while controls are hidden — on mobile Safari an interactive iframe steals
   * touches from the Luscreens bar even when it sits above the iframe.
   */
  get keanIframeInteractive(): boolean {
    return (
      this.isMovies111Provider &&
      (!this.isPlaying || this.keanAwaitingGesturePlay) &&
      !this.showPlayerControls &&
      !this.forceControlsVisible
    );
  }

  /** Shield opens / edge strips while the iframe is the tap target. */
  get keanPassThrough(): boolean {
    return this.keanIframeInteractive;
  }
  /**
   * Pixel size for the Kean iframe so a 16:9 Vidlove surface covers the host
   * (container-query CSS is flaky on mobile web).
   */
  keanIframeFillStyle: Record<string, string> = {
    inset: '0',
    width: '100%',
    height: '100%',
  };
  private keanFillObserver: ResizeObserver | null = null;
  private keanFillHostEl: HTMLElement | null = null;
  /** True when using fixed inset-0 fullscreen because requestFullscreen failed (common on iOS web). */
  private cssFullscreenFallback = false;
  /** Portrait phone/tablet viewport — used to force landscape layout in web fullscreen. */
  isPortraitViewport = false;
  /** Tiny overscan only — higher values crop the picture too hard on mobile. */
  private static readonly KEAN_FILL_OVERSCAN = 1.02;
  /** Avoid reload loops when Peachify reports a mismatched season/episode. */
  private peachifyEpisodeReassertUntil = 0;

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

  get isPeachifyProvider(): boolean {
    return this.selectedProvider === 'peachify';
  }

  get isVidupProvider(): boolean {
    return this.selectedProvider === 'vidup';
  }

  get isVideasyProvider(): boolean {
    return this.selectedProvider === 'videasy';
  }

  get isMovies111Provider(): boolean {
    return this.selectedProvider === 'movies111';
  }

  /**
   * Mobile web often can't lock orientation — rotate the fullscreen surface
   * so portrait phones still get a landscape player.
   */
  get forceLandscapeFullscreen(): boolean {
    return this.isFullscreen && this.isPortraitViewport;
  }

  /**
   * Keep chrome forced-on only for real reload/boot splash.
   * Kean must not stay stuck visible via isPlayerReloading after playback starts.
   */
  get forceControlsVisible(): boolean {
    if (this.isMovies111Provider) {
      return this.keanBootCover;
    }
    return this.isPlayerReloading;
  }

  /** TMDB image shown over Kean while paused (backdrop preferred, poster fallback). */
  get keanPausePosterUrl(): string | null {
    if (this.backdropPath) {
      const path = this.backdropPath.startsWith('/')
        ? this.backdropPath
        : `/${this.backdropPath}`;
      return `https://image.tmdb.org/t/p/w1280${path}`;
    }
    if (this.posterPath) {
      const path = this.posterPath.startsWith('http')
        ? this.posterPath
        : `https://image.tmdb.org/t/p/w780${
            this.posterPath.startsWith('/') ? this.posterPath : `/${this.posterPath}`
          }`;
      return path;
    }
    return null;
  }

  get showKeanPausePoster(): boolean {
    return (
      this.isMovies111Provider &&
      !this.isPlaying &&
      !this.keanAwaitingGesturePlay &&
      !this.keanBootCover &&
      !this.isPlayerReloading &&
      !!this.keanPausePosterUrl
    );
  }

  /** Embed hosts with a real subtitle query param (reload to apply). */
  get usesEmbedSubParam(): boolean {
    return this.isVidfastProvider || this.isVidupProvider || this.isPeachifyProvider;
  }

  /** Providers that accept `server=` (or equivalent) via URL reload. */
  get usesServerParam(): boolean {
    return this.isVidfastProvider || this.isVidupProvider || this.isPeachifyProvider;
  }

  /**
   * Local media + Luscreens controller (ApiPlayer / VidPhantom only).
   */
  get usesLocalHls(): boolean {
    return this.isApiplayerProvider || this.isVidphantomProvider;
  }

  /** Iframe embeds (PLAYER_EVENT and/or progress postMessage). */
  get usesRemoteIframe(): boolean {
    return (
      this.isVidfastProvider ||
      this.isCinemaosProvider ||
      this.isPeachifyProvider ||
      this.isVidupProvider ||
      this.isVideasyProvider ||
      this.isMovies111Provider
    );
  }

  /**
   * Player chrome is mounted for either embed provider.
   * Stay mounted while remounting (embedUrl briefly null) so fullscreen is not exited.
   */
  get hasPlayerSurface(): boolean {
    return this.usesLocalHls || !!this.embedUrl || this.playerSurfaceLocked;
  }

  get serverOptions(): { id: string; label: string }[] {
    const names = this.serversForProvider(this.selectedProvider);
    return [
      { id: FrameComponent.AUTO_SERVER_ID, label: 'Auto' },
      ...names.map((id) => ({ id, label: id })),
    ];
  }

  private serversForProvider(provider: StreamProvider): string[] {
    switch (provider) {
      case 'vidfast': {
        const fromEnv = (environment as { streamServers?: string[] }).streamServers ?? [];
        const preferred = environment.streamServer || 'vEdge';
        return [...new Set([preferred, ...fromEnv].filter(Boolean))];
      }
      case 'peachify':
        // https://peachify.pro/ — ?server= on peachify.top
        return ['iron', 'spider', 'multi', 'dark', 'wolf'];
      case 'vidup':
        // Docs expose server= but no public pin list — Auto only
        return [];
      default:
        return [];
    }
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

  /** Guests follow the host; only Sync is shared control. */
  get canControlPartyPlayback(): boolean {
    if (!this.watchParty.connected) {
      return true;
    }
    return this.watchParty.role === 'host';
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
  private routeParamsSub: Subscription | null = null;
  private ignorePartyBroadcastUntil = 0;
  private lastLocalProgressSaveAt = 0;
  private lastClearedRestartAt = 0;
  /** Only auto-correct embed resume for cleared titles during this window. */
  private clearedBootstrapUntil = 0;
  /** True once playback was near 0 or the user scrubbed — stop fighting seeks. */
  private clearedSessionReady = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onFullscreenChange = (): void => {
    // Ignore transient fullscreen loss while the embed remounts (server/provider switch)
    if (this.playerSurfaceLocked && this.isFullscreen && !document.fullscreenElement) {
      return;
    }
    // Keep CSS fallback active when native fullscreen never attached (mobile Safari).
    if (this.cssFullscreenFallback && !document.fullscreenElement) {
      this.isFullscreen = true;
      this.updatePortraitViewport();
      this.syncKeanIframeFill();
      this.revealPlayerControls();
      return;
    }
    this.cssFullscreenFallback = false;
    this.isFullscreen = !!document.fullscreenElement;
    void this.syncFullscreenOrientation(this.isFullscreen);
    this.updatePortraitViewport();
    this.syncKeanIframeFill();
    this.revealPlayerControls();
  };

  private readonly onOrientationOrResize = (): void => {
    this.ngZone.run(() => {
      this.updatePortraitViewport();
      if (this.isFullscreen) {
        this.syncKeanIframeFill();
        this.cdr.detectChanges();
      }
    });
  };

  @ViewChild('seasonScroll') seasonScroll!: ElementRef;
  @ViewChild('episodeScroll') episodeScroll!: ElementRef;
  @ViewChild('playerIframe') playerIframe!: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerVideo') playerVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('playerContainer') playerContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('keanFillHost')
  set keanFillHost(ref: ElementRef<HTMLDivElement> | undefined) {
    this.keanFillHostEl = ref?.nativeElement ?? null;
    this.bindKeanFillObserver();
  }
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
    private ngZone: NgZone,
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
    window.addEventListener('orientationchange', this.onOrientationOrResize);
    window.addEventListener('resize', this.onOrientationOrResize);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.updatePortraitViewport();
    this.setupWatchParty();
    this.startProgressTimer();
    // Warm provider RTT so the first open can pick lowest-ping primary
    void this.refreshProviderPings(true);

    // Angular reuses this component across /frame/... titles — must react to param changes
    // so watch-party guests (and the host) load the host's new movie.
    this.routeParamsSub = this.route.paramMap.subscribe((params) => {
      this.applyRouteParams(params);
    });

    void this.tryRestoreWatchParty();
  }

  ngOnDestroy(): void {
    this.persistLocalProgress(true);
    this.stopProgressTimer();
    this.clearControlsHideTimer();
    this.clearServerFailoverWatch();
    this.clearPlayerReloading();
    this.clearSeekGuard();
    this.clearSubtitles();
    if (this.peachifyControlTimer != null) {
      clearTimeout(this.peachifyControlTimer);
      this.peachifyControlTimer = null;
    }
    if (this.peachifyRemountTimer != null) {
      clearTimeout(this.peachifyRemountTimer);
      this.peachifyRemountTimer = null;
    }
    if (this.movies111ControlTimer != null) {
      clearTimeout(this.movies111ControlTimer);
      this.movies111ControlTimer = null;
    }
    if (this.movies111RemountTimer != null) {
      clearTimeout(this.movies111RemountTimer);
      this.movies111RemountTimer = null;
    }
    this.clearKeanSetTimeTimers();
    this.clearKeanBootTimer();
    this.teardownKeanFillObserver();
    this.keanBootCover = false;
    this.cssFullscreenFallback = false;
    this.playerSurfaceLocked = false;
    this.apiplayerLoadToken++;
    this.subtitleLoadToken++;
    this.destroyApiplayerVideo();
    window.removeEventListener('message', this.onPlayerMessage);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('orientationchange', this.onOrientationOrResize);
    window.removeEventListener('resize', this.onOrientationOrResize);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    void this.syncFullscreenOrientation(false);
    this.closePictureInPicture();
    this.routeParamsSub?.unsubscribe();
    this.routeParamsSub = null;
    this.watchPartySubs.unsubscribe();
    // WatchPartyService is root-scoped and must stay alive when the host changes titles.
    // leaveParty() / beforeunload handle cleanup.
  }

  /**
   * Load (or reload) the frame when the route id/title changes.
   * Without this, SPA navigation keeps the previous movie on screen.
   */
  private applyRouteParams(params: ParamMap): void {
    const mediaType = params.get('media_type') || '';
    const id = params.get('id') || '';
    const seasonParam = params.get('season');
    const episodeParam = params.get('episode');

    if (!mediaType || !id) {
      console.error('Missing required route parameters.');
      return;
    }

    const nextSeason = seasonParam ? +seasonParam : this.selectedSeason;
    const nextEpisode = episodeParam ? +episodeParam : this.selectedEpisode;
    const titleChanged =
      mediaType !== this.mediaType || String(id) !== String(this.id);
    const episodeChanged =
      mediaType === 'tv' &&
      (nextSeason !== this.selectedSeason || nextEpisode !== this.selectedEpisode);

    // Ignore duplicate emissions after the title is already loaded
    if (!titleChanged && !episodeChanged && this.title) {
      return;
    }

    this.mediaType = mediaType;
    this.id = id;
    if (seasonParam) {
      this.selectedSeason = +seasonParam;
    }
    if (episodeParam) {
      this.selectedEpisode = +episodeParam;
    }

    if (titleChanged) {
      // Drop stale title so we don't broadcast the previous movie to the party
      this.title = '';
      this.posterPath = null;
      this.backdropPath = '';
      this.providerLockedByUser = false;
      this.providerPriorityApplied = false;
      this.providerPriorityPromise = null;
      this.resetPlayerState();
      this.resetServerFailoverState();
      this.isLoading = true;
      this.embedUrl = null;
      this.destroyApiplayerVideo();
      this.beginClearedBootstrapIfNeeded();
      if (mediaType === 'movie') {
        this.fetchMovieDetails();
      } else if (mediaType === 'tv') {
        this.fetchTvDetails();
      } else {
        console.error('Invalid media type.');
        this.isLoading = false;
      }
      this.fetchLogo(mediaType, +id);
      return;
    }

    // Same show, different episode — refresh player + party media pin
    if (episodeChanged) {
      this.resetServerFailoverState();
      this.updateEmbedUrl();
      this.syncWatchPartyMedia();
    }
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
      this.peachifyWantAutoPlay = true;
      this.movies111WantAutoPlay = false;
      this.openPlayer();
      this.syncWatchPartyMedia();
    }
  }

  /** Mount local HLS or remote iframe for the active provider. */
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
    if (this.isMovies111Provider) {
      this.beginKeanBootCover();
    }
    this.embedUrl = this.buildActiveEmbedUrl(resumeAt);
  }

  private resolveStartAt(resumeAt?: number): number {
    const cleared = this.watchProgress.isSuppressed(this.mediaType, this.id);
    if (cleared) {
      return 0;
    }
    // Explicit 0 must win (Peachify URL control / cleared seek) — don't fall back to saved
    if (resumeAt != null && Number.isFinite(resumeAt) && resumeAt >= 0) {
      return resumeAt;
    }
    return this.getSavedStartAt();
  }

  private buildActiveEmbedUrl(resumeAt?: number): SafeResourceUrl {
    switch (this.selectedProvider) {
      case 'cinemaos':
        return this.buildCinemaosEmbedUrl(resumeAt);
      case 'peachify':
        return this.buildPeachifyEmbedUrl(resumeAt);
      case 'videasy':
        return this.buildVideasyEmbedUrl(resumeAt);
      case 'movies111':
        return this.buildMovies111EmbedUrl(resumeAt);
      case 'vidup': {
        const path = this.getEmbedPath();
        return path
          ? this.buildVidupEmbedUrl(path, resumeAt)
          : this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
      }
      case 'vidfast':
      default: {
        const path = this.getEmbedPath();
        return path
          ? this.buildVidfastEmbedUrl(path, resumeAt)
          : this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
      }
    }
  }

  private buildEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    if (this.isCinemaosProvider) {
      return this.buildCinemaosEmbedUrl(resumeAt);
    }
    if (this.isPeachifyProvider) {
      return this.buildPeachifyEmbedUrl(resumeAt);
    }
    if (this.isVideasyProvider) {
      return this.buildVideasyEmbedUrl(resumeAt);
    }
    if (this.isMovies111Provider) {
      return this.buildMovies111EmbedUrl(resumeAt);
    }
    if (this.isVidupProvider) {
      return this.buildVidupEmbedUrl(path, resumeAt);
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

  /** https://vidup.to/ — same shape as VidFast */
  private buildVidupEmbedUrl(path: string, resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    const params = new URLSearchParams({
      autoPlay: 'true',
      theme: 'e50914',
      title: 'false',
      hideServer: 'true',
      fullscreenButton: 'false',
      chromecast: 'false',
    });
    if (!this.useAutoServer && this.selectedServer) {
      params.set('server', this.selectedServer);
    }
    if (this.selectedSubtitle) {
      params.set('sub', this.selectedSubtitle);
    }
    params.set('startAt', String(Math.max(0, Math.floor(this.resolveStartAt(resumeAt)))));
    if (this.mediaType === 'tv') {
      params.set('nextButton', 'true');
      params.set('autoNext', 'true');
    }
    const url = `https://vidup.to/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /**
   * https://peachify.pro/ → https://peachify.top/embed/...
   * Parent→player commands are disabled; Luscreens controls via autoPlay + startAt reloads.
   * TV auto-next is off so season/episode stay locked to our picker.
   */
  private buildPeachifyEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }

    const season = Math.max(1, Math.floor(Number(this.selectedSeason) || 1));
    const episode = Math.max(1, Math.floor(Number(this.selectedEpisode) || 1));
    const path =
      this.mediaType === 'tv'
        ? `embed/tv/${this.id}/${season}/${episode}`
        : `embed/movie/${this.id}`;

    const params = new URLSearchParams({
      autoPlay: this.peachifyWantAutoPlay ? 'true' : 'false',
      accent: 'e50914',
      // Hide Peachify chrome entirely — Luscreens owns controls; pins still use ?server=
      servers: 'hide',
      pip: 'hide',
      cast: 'hide',
      fullscreen: 'hide',
      volume: 'hide',
      captions: 'hide',
      quality: 'hide',
      play: 'hide',
      rewind: 'hide',
      forward: 'hide',
      timegroup: 'hide',
      timeslider: 'hide',
      settings: 'hide',
      // Pin this exact S/E — Peachify's internal browser can otherwise drift
      ep: this.mediaType === 'tv' ? `s${season}e${episode}` : 'movie',
      // Force a real navigation on every play/pause/server switch
      _cb: String(++this.peachifyEmbedNonce),
    });

    const peachifyPins = this.serversForProvider('peachify');
    if (!this.useAutoServer) {
      const pin = peachifyPins.includes(this.selectedServer)
        ? this.selectedServer
        : peachifyPins[0];
      if (pin) {
        params.set('server', pin);
      }
    }

    // Docs expect subtitle labels (e.g. English), not ISO codes
    if (this.selectedSubtitle) {
      const subLabel =
        this.subtitleOptions.find((o) => o.code === this.selectedSubtitle)?.label ??
        this.selectedSubtitle;
      params.set('sub', subLabel);
    }

    // Always pin start — Peachify otherwise restores its own peachifyProgress cache
    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    params.set('startAt', String(startAt));
    params.set('progress', String(startAt));
    params.set('t', String(startAt));

    if (this.mediaType === 'tv') {
      // Luscreens owns next/prev — Peachify auto-next was jumping to wrong episodes
      params.set('autoNext', 'false');
      params.set('showNextBtn', 'false');
    }

    const url = `https://peachify.top/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** https://www.videasy.to/docs → player.videasy.net */
  private buildVideasyEmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }
    const path =
      this.mediaType === 'tv'
        ? `tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
        : `movie/${this.id}`;
    const params = new URLSearchParams({
      color: 'e50914',
      overlay: 'false',
    });
    if (this.mediaType === 'tv') {
      params.set('nextEpisode', 'true');
      params.set('autoplayNextEpisode', 'true');
    }
    const startAt = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    if (startAt > 0) {
      params.set('progress', String(startAt));
    }
    const url = `https://player.videasy.net/${path}?${params.toString()}`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /**
   * Kean — Vidlove embed (https://vidlove.cc/#embed).
   * Outbound: PLAYER_EVENT / MEDIA_DATA (docs still say WATCH_PROGRESS).
   * Inbound: SET_TIME for seek; play/pause via autoplay remount (no SET_PLAY).
   */
  private buildMovies111EmbedUrl(resumeAt?: number): SafeResourceUrl {
    this.pendingSeekSeconds = null;
    if (!this.id || !this.mediaType) {
      return this.sanitizer.bypassSecurityTrustResourceUrl('about:blank');
    }
    const path =
      this.mediaType === 'tv'
        ? `embed/tv/${this.id}/${this.selectedSeason}/${this.selectedEpisode}`
        : `embed/movie/${this.id}`;

    // autoplay=true forces muted+volume=0 in Vidlove — always false; tap-to-play for sound.
    // hide* strips their chrome so Luscreens owns the controller UI.
    const params = new URLSearchParams({
      autoplay: 'false',
      poster: 'false',
      primarycolor: 'e50914',
      secondarycolor: '141414',
      iconcolor: 'ffffff',
      hideprogresscontrol: 'true',
      hidenextbutton: 'true',
      hidechromecast: 'true',
      hideepisodelist: 'true',
      hidepip: 'true',
      hideposter: 'true',
      hideserver: 'true',
      hidesetting: 'true',
      hideautoplay: 'true',
      hideautonext: 'true',
      hidetitle: 'true',
      hidequality: 'true',
      hideplaybackspeed: 'true',
      hideaudiotrack: 'true',
      // Keep zoom/aspect UI hidden; default inside player is 16:9 contain
      // (no documented URL to force "fit" — Luscreens CSS cover-scales the iframe).
      hidezoom: 'true',
      hideaspectratio: 'true',
      hideiconset: 'true',
      hideprimarycolor: 'true',
      hidesecondarycolor: 'true',
      hideiconcolor: 'true',
    });
    if (this.mediaType === 'tv') {
      params.set('autonext', 'false');
      params.set('nextbutton', 'false');
      params.set('episodes', 'false');
    }
    params.set('_k', String(++this.movies111EmbedNonce));

    const at = Math.max(0, Math.floor(this.resolveStartAt(resumeAt)));
    this.movies111PendingSetTime = at > 0 ? at : null;
    if (at > 0) {
      this.currentTime = at;
    }

    const url = `https://player.vidlove.cc/${path}?${params.toString()}`;
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
      let mediaKind: 'hls' | 'mp4' = 'hls';
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

      await this.attachHlsToVideo(masterUrl, resumeAt, mediaKind);

      if (loadToken !== this.apiplayerLoadToken) {
        return;
      }

      this.clearPlayerReloading();
      this.beginClearedBootstrapIfNeeded();
      // Local stream attached — don't wait for play events or failover will steal the provider.
      this.serverPlaybackOk = true;
      this.clearServerFailoverWatch();
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
      if (this.providerLockedByUser) {
        this.showNoServerFound();
        return;
      }
      const next = this.nextFailoverProvider(provider);
      if (next) {
        this.selectedProvider = next;
        if (next === 'vidfast' || next === 'vidup' || next === 'peachify') {
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
   * Priority: #1 ApiPlayer, #2 VidFast, then remaining by lowest ping.
   * Failed / unknown pings sort last among the ping-ranked group.
   */
  private getProviderFailoverOrder(): StreamProvider[] {
    const byPing: StreamProvider[] = [
      'apiplayer',
      'vidfast',
      'cinemaos',
      'vidphantom',
      'peachify',
      'vidup',
      'videasy',
    ];
    const ranked = [...byPing].sort((a, b) => {
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
    return ['movies111', ...ranked];
  }

  /** Apply fixed primary (Kean) once; pings only order the fallbacks. */
  private ensureProviderPriority(): Promise<void> {
    if (!this.providerPriorityPromise) {
      this.providerPriorityPromise = this.resolveProviderPriority();
    }
    return this.providerPriorityPromise;
  }

  private async resolveProviderPriority(): Promise<void> {
    // Warm pings for failover order (non-blocking for primary)
    void this.refreshProviderPings(true);
    if (this.providerPriorityApplied) {
      return;
    }
    this.providerPriorityApplied = true;
    this.selectedProvider =
      (environment as { streamProvider?: StreamProvider }).streamProvider || 'movies111';
    this.movies111WantAutoPlay = false;
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

  private attachHlsToVideo(
    masterUrl: string,
    resumeAt?: number,
    mediaKind: 'hls' | 'mp4' = 'hls'
  ): Promise<void> {
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

        if (mediaKind === 'mp4' || /\.mp4(\?|$)/i.test(masterUrl)) {
          video.src = masterUrl;
          video.addEventListener('loadedmetadata', () => onReady(), { once: true });
          video.addEventListener('error', () => reject(new Error('MP4 playback failed')), {
            once: true,
          });
          return;
        }

        if (Hls.isSupported()) {
          const hls = new Hls({
            // Workers can decode audio-only / black frames under our overlay stack
            enableWorker: false,
            lowLatencyMode: false,
            startLevel: -1,
            capLevelToPlayerSize: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            backBufferLength: 30,
            fragLoadPolicy: {
              default: {
                maxTimeToFirstByteMs: 15000,
                maxLoadTimeMs: 60000,
                timeoutRetry: {
                  maxNumRetry: 3,
                  retryDelayMs: 500,
                  maxRetryDelayMs: 4000,
                },
                errorRetry: {
                  maxNumRetry: 3,
                  retryDelayMs: 500,
                  maxRetryDelayMs: 4000,
                },
              },
            },
          });
          this.hlsPlayer = hls;
          let settled = false;
          let blackRecoveries = 0;
          const finish = (err?: unknown): void => {
            if (settled) {
              return;
            }
            settled = true;
            video.removeEventListener('loadeddata', onFrame);
            video.removeEventListener('playing', onFrame);
            if (err) {
              reject(err);
              return;
            }
            onReady();
          };
          // Wait for a real video frame — timer/audio alone can look "playing" with a black screen
          const onFrame = (): void => {
            if (video.videoWidth > 0) {
              finish();
            }
          };
          hls.loadSource(masterUrl);
          hls.attachMedia(video);
          video.addEventListener('loadeddata', onFrame);
          video.addEventListener('playing', onFrame);
          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            const levels = data.levels || [];
            // Prefer a level that clearly has video resolution
            const pick = levels.findIndex((l) => (l.height || 0) >= 360);
            const fallback = levels.findIndex((l) => (l.height || 0) > 0);
            const start = pick >= 0 ? pick : fallback >= 0 ? fallback : 0;
            if (levels.length) {
              hls.startLevel = start;
              hls.currentLevel = start;
            }
            void video.play().catch(() => undefined);
            // If still black, bump quality / recover decoder (don't fake "ready")
            const nudge = (): void => {
              if (settled) {
                return;
              }
              if (video.videoWidth > 0) {
                finish();
                return;
              }
              if (blackRecoveries < 2 && levels.length > 1) {
                blackRecoveries += 1;
                const next = Math.min(levels.length - 1, start + blackRecoveries);
                try {
                  hls.currentLevel = next;
                  hls.recoverMediaError();
                  video.currentTime = Math.max(0, video.currentTime) + 0.05;
                  void video.play().catch(() => undefined);
                } catch {
                  // ignore
                }
                setTimeout(nudge, 2500);
                return;
              }
              finish(new Error('HLS started without a video frame'));
            };
            setTimeout(nudge, 3500);
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              finish(data);
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
    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;
    this.playerReloadLabel = label;
    this.isPlayerReloading = true;
    // Keep provider/server menus reachable while the new source boots
    this.showPlayerControls = true;
    this.clearControlsHideTimer();
    this.armReloadOverlayTimeout();

    if (this.usesLocalHls) {
      void this.loadLocalHlsVideo(time > 5 ? time : undefined);
      this.ensureFullscreenPreserved(stayFullscreen);
      return;
    }

    this.destroyApiplayerVideo();
    // Keep previous frame painted under the overlay; swap src on next tick
    this.playerSurfaceLocked = true;
    setTimeout(() => {
      this.openPlayer(time > 5 ? time : undefined);
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 50);
  }

  private armReloadOverlayTimeout(): void {
    if (this.reloadOverlayTimer != null) {
      clearTimeout(this.reloadOverlayTimer);
    }
    this.reloadOverlayTimer = setTimeout(() => {
      this.reloadOverlayTimer = null;
      if (this.isPlayerReloading) {
        this.isPlayerReloading = false;
        this.cdr.detectChanges();
      }
    }, FrameComponent.RELOAD_OVERLAY_MAX_MS);
  }

  private clearPlayerReloading(): void {
    if (this.reloadOverlayTimer != null) {
      clearTimeout(this.reloadOverlayTimer);
      this.reloadOverlayTimer = null;
    }
    this.isPlayerReloading = false;
  }

  onPlayerIframeLoad(): void {
    this.beginClearedBootstrapIfNeeded();
    this.requestPlayerStatus();
    // Kean: keep splash up — iframe "load" fires before Vidlove's own controller/boot UI finishes
    if (this.isMovies111Provider) {
      this.serverPlaybackOk = true;
      this.clearServerFailoverWatch();
      this.isPlaying = false;
      this.keanAwaitingGesturePlay = true;
      this.revealPlayerControls();
      this.flushKeanPendingSetTime();
      this.scheduleKeanBootClear(FrameComponent.KEAN_BOOT_COVER_MS);
      // Layout may settle after paint (esp. mobile CSS fullscreen)
      requestAnimationFrame(() => {
        this.syncKeanIframeFill();
        this.cdr.detectChanges();
      });
    } else {
      this.clearPlayerReloading();
      this.armServerFailoverWatch();
    }
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
    if (!this.usesServerParam) {
      return;
    }
    this.showServerMenu = !this.showServerMenu;
    this.showProviderMenu = false;
    this.showCcMenu = false;
    this.revealPlayerControls();
  }

  /** pointerup so the click-shield can't swallow the gesture after the menu opens. */
  onServerMenuPick(event: Event, serverId: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectServer(serverId);
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
    this.providerLockedByUser = true;
    this.selectedProvider = provider;
    this.peachifyWantAutoPlay = true;
    this.movies111WantAutoPlay = false;
    this.keanAwaitingGesturePlay = provider === 'movies111';
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.resetServerFailoverState();
    // Prefer Auto when entering a host with its own server pins
    if (this.usesServerParam) {
      this.useAutoServer = true;
      const pins = this.serversForProvider(provider);
      if (pins.length && !pins.includes(this.selectedServer)) {
        this.selectedServer = pins[0];
      }
    }
    // Embed `sub=` hosts — drop our cue overlay so it doesn't double up
    if (this.usesEmbedSubParam) {
      this.clearSubtitles(false);
    }

    if (provider === 'peachify') {
      this.playerReloadLabel = `Switching to ${this.activeProviderLabel}…`;
      this.remountPeachifyEmbed(Math.max(0, Math.floor(this.currentTime)));
      return;
    }

    this.reloadPlayer(
      this.currentTime,
      `Switching to ${this.activeProviderLabel}…`
    );
  }

  selectServer(server: string): void {
    if (!this.usesServerParam) {
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

    // Peachify needs a full iframe remount or ?server= is ignored
    if (this.isPeachifyProvider) {
      this.peachifyWantAutoPlay = true;
      this.playerReloadLabel = wantsAuto
        ? 'Finding a server…'
        : `Switching to ${server}…`;
      this.remountPeachifyEmbed(Math.max(0, Math.floor(this.currentTime)));
      return;
    }

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

  private switchProviderForFailover(next: StreamProvider): boolean {
    if (this.providerLockedByUser) {
      return false;
    }
    this.selectedProvider = next;
    if (next === 'vidfast' || next === 'vidup' || next === 'peachify') {
      this.useAutoServer = true;
    }
    return true;
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

    // HLS / iframe hosts without server pins: try the next provider
    if (this.usesLocalHls || !this.usesServerParam) {
      this.serverFailoverTimer = setTimeout(() => {
        if (this.serverPlaybackOk) {
          return;
        }
        if (this.providerLockedByUser) {
          this.showNoServerFound();
          return;
        }
        const next = this.nextFailoverProvider(this.selectedProvider);
        if (!next) {
          this.showNoServerFound();
          return;
        }
        if (!this.switchProviderForFailover(next)) {
          this.showNoServerFound();
          return;
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
      this.clearPlayerReloading();
    }
  }

  private showNoServerFound(): void {
    this.playerReloadLabel = 'No working server found';
    this.isPlayerReloading = true;
    this.showPlayerControls = true;
    this.armReloadOverlayTimeout();
  }

  /** Current server pin never started — try next pin, then Auto, then next provider. */
  private tryNextServerFailover(): void {
    if (this.serverPlaybackOk) {
      return;
    }

    if (!this.usesServerParam) {
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

    const next = this.nextFailoverProvider(this.selectedProvider);
    if (next && this.switchProviderForFailover(next)) {
      this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
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
          this.clearPlayerReloading();
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

    // Kean / Vidlove — parent-only progress API (no HTTP webhook from player.vidlove.cc).
    // Docs show WATCH_PROGRESS; live embed posts PLAYER_EVENT + MEDIA_DATA via postMessage.
    if (event.origin === 'https://player.vidlove.cc' && this.isMovies111Provider) {
      if (this.handleKeanVidloveProgress(event.data)) {
        return;
      }
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

  /**
   * Kean / Vidlove progress bridge (parent window only).
   *
   * Docs (vidlove.cc marketing copy — not present in the live player bundle):
   *   { type: 'WATCH_PROGRESS', data: { mediaId, eventType, currentTime, duration } }
   *
   * Live player.vidlove.cc (`emitEvent` → `parent.postMessage(e, '*')`):
   *   { type: 'PLAYER_EVENT', data: { event, currentTime, duration, tmdbId, mediaType, season?, episode? } }
   *   { type: 'MEDIA_DATA', data: { id, type, progress, show_progress?, ... } }  // vidLinkProgress shape
   *
   * Playback events update the Luscreens controller; progress is written through
   * WatchProgressService → UserLibraryService → auth-api PUT /me/library when logged in.
   */
  private handleKeanVidloveProgress(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      return false;
    }

    const msg = raw as {
      type?: string;
      data?: Record<string, unknown>;
    };
    const type = String(msg.type || '');
    const body = msg.data;

    if (type === 'MEDIA_DATA') {
      return this.applyKeanMediaData(body);
    }

    if (!body || typeof body !== 'object') {
      return false;
    }

    let eventType = '';
    if (type === 'WATCH_PROGRESS') {
      // Exact docs shape (if/when the player ships it)
      eventType = String(body['eventType'] ?? 'timeupdate').toLowerCase();
    } else if (type === 'PLAYER_EVENT') {
      // What the live embed posts today
      eventType = String(body['event'] ?? body['eventType'] ?? 'timeupdate').toLowerCase();
    } else {
      return false;
    }

    const currentTime = Number(body['currentTime']);
    const duration = Number(body['duration']);
    const mediaId = body['mediaId'] ?? body['tmdbId'] ?? this.id;

    const mapped: PlayerEventName =
      eventType === 'play' ||
      eventType === 'pause' ||
      eventType === 'seeked' ||
      eventType === 'ended' ||
      eventType === 'timeupdate'
        ? eventType
        : eventType === 'time'
          ? 'timeupdate'
          : eventType === 'complete'
            ? 'ended'
            : 'timeupdate';

    const playing =
      mapped === 'play' ? true : mapped === 'pause' || mapped === 'ended' ? false : this.isPlaying;

    // Docs-style mirror + Luscreens continue-watching (server sync via UserLibraryService)
    this.mirrorKeanDocsProgress(mediaId, {
      currentTime: Number.isFinite(currentTime) ? currentTime : this.currentTime,
      duration: Number.isFinite(duration) ? duration : this.duration,
      eventType: mapped,
      season: Number(body['season']) || this.selectedSeason,
      episode: Number(body['episode']) || this.selectedEpisode,
    });

    if (mapped === 'play') {
      this.keanAwaitingGesturePlay = false;
    } else if (mapped === 'pause' || mapped === 'ended') {
      this.keanAwaitingGesturePlay = true;
    }

    this.onPlayerEvent({
      event: mapped,
      currentTime: Number.isFinite(currentTime) ? currentTime : this.currentTime,
      duration: Number.isFinite(duration) && duration > 0 ? duration : this.duration,
      tmdbId: +this.id || Number(mediaId) || 0,
      mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
      season: Number(body['season']) || this.selectedSeason,
      episode: Number(body['episode']) || this.selectedEpisode,
      playing,
      muted: false,
      volume: 1,
    });
    // First real player event ⇒ Vidlove boot UI is gone
    if (mapped === 'play' || mapped === 'timeupdate' || mapped === 'pause') {
      this.clearKeanBootCover();
    }
    this.cdr.detectChanges();
    return true;
  }

  /** Cover Vidlove's native loader/chrome with the Luscreens splash. */
  private beginKeanBootCover(): void {
    this.keanBootCover = true;
    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.armReloadOverlayTimeout();
    this.scheduleKeanBootClear(FrameComponent.KEAN_BOOT_COVER_MS);
    this.cdr.detectChanges();
  }

  private scheduleKeanBootClear(delayMs: number): void {
    this.clearKeanBootTimer();
    this.keanBootClearTimer = setTimeout(() => {
      this.keanBootClearTimer = null;
      this.clearKeanBootCover();
    }, delayMs);
  }

  private clearKeanBootTimer(): void {
    if (this.keanBootClearTimer != null) {
      clearTimeout(this.keanBootClearTimer);
      this.keanBootClearTimer = null;
    }
  }

  private clearKeanBootCover(): void {
    this.clearKeanBootTimer();
    const wasCovering = this.keanBootCover || this.isPlayerReloading;
    this.keanBootCover = false;
    if (this.isMovies111Provider) {
      this.clearPlayerReloading();
    }
    if (wasCovering) {
      // Boot splash was pinning chrome — resume normal auto-hide while playing.
      if (this.isPlaying) {
        this.scheduleControlsHide();
      }
      this.cdr.detectChanges();
    }
  }

  /** Docs example: localStorage `progress_${mediaId}` — also feeds WatchProgressService. */
  private mirrorKeanDocsProgress(
    mediaId: unknown,
    input: {
      currentTime: number;
      duration: number;
      eventType: string;
      season?: number;
      episode?: number;
    }
  ): void {
    const id = String(mediaId ?? this.id ?? '');
    if (!id) {
      return;
    }

    const mediaType = this.mediaType === 'tv' ? 'tv' : 'movie';
    const watched = Math.max(0, input.currentTime);
    const duration = Math.max(0, input.duration);
    const lastWatched = Date.now();
    const watchedPct =
      duration > 0 ? Math.round((watched / duration) * 1000) / 10 : 0;

    try {
      localStorage.setItem(
        `progress_${id}`,
        JSON.stringify({
          currentTime: watched,
          duration,
          lastWatched,
          eventType: input.eventType,
          mediaType,
          season: input.season,
          episode: input.episode,
          watched_percentage: watchedPct,
        })
      );
    } catch {
      // private mode / quota
    }
  }

  /**
   * Live Vidlove MEDIA_DATA — same shape as vidLinkProgress / WatchProgressEntry.
   * Only accept the title currently open so foreign dumps never overwrite history.
   */
  private applyKeanMediaData(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      return false;
    }

    const data = raw as Record<string, unknown>;
    const id = Number(data['id'] ?? this.id);
    const type = data['type'] === 'tv' ? 'tv' : data['type'] === 'movie' ? 'movie' : null;
    if (!id || !type || String(id) !== String(this.id)) {
      return false;
    }
    if (type !== (this.mediaType === 'tv' ? 'tv' : 'movie')) {
      return false;
    }

    let watched = 0;
    let duration = 0;
    let season = this.selectedSeason;
    let episode = this.selectedEpisode;

    if (type === 'tv') {
      season = Number(data['last_season_watched']) || season;
      episode = Number(data['last_episode_watched']) || episode;
      const showProgress = data['show_progress'] as
        | Record<string, { progress?: { watched?: number; duration?: number } }>
        | undefined;
      const ep = showProgress?.[`s${season}e${episode}`]?.progress;
      watched = Number(ep?.watched ?? (data['progress'] as { watched?: number } | undefined)?.watched);
      duration = Number(ep?.duration ?? (data['progress'] as { duration?: number } | undefined)?.duration);
    } else {
      const progress = data['progress'] as { watched?: number; duration?: number } | undefined;
      watched = Number(progress?.watched);
      duration = Number(progress?.duration);
    }

    if (!Number.isFinite(watched) || watched < 0) {
      return false;
    }
    if (!Number.isFinite(duration) || duration < 0) {
      duration = this.duration;
    }

    if (Number.isFinite(watched)) {
      this.currentTime = watched;
    }
    if (duration > 1) {
      this.duration = duration;
    }

    this.mirrorKeanDocsProgress(id, {
      currentTime: watched,
      duration,
      eventType: 'timeupdate',
      season,
      episode,
    });

    this.watchProgress.upsertPlayback({
      mediaType: type,
      id,
      season,
      episode,
      watched,
      duration,
      title: (typeof data['title'] === 'string' && data['title']) || this.title,
      posterPath: typeof data['poster_path'] === 'string' ? data['poster_path'] : null,
      backdropPath:
        typeof data['backdrop_path'] === 'string' ? data['backdrop_path'] : this.backdropPath,
    });

    this.cdr.detectChanges();
    return true;
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

  private isPeachifyOrigin(origin: string): boolean {
    return this.peachifyOrigins.includes(origin) || /peachify\./i.test(origin || '');
  }

  private isVidupOrigin(origin: string): boolean {
    return this.vidupOrigins.includes(origin) || /vidup\./i.test(origin || '');
  }

  private isMovies111Origin(origin: string): boolean {
    return (
      origin === 'https://player.vidlove.cc' ||
      this.movies111Origins.includes(origin) ||
      /111movies\./i.test(origin || '') ||
      /vidlove\./i.test(origin || '')
    );
  }

  private isVideasyOrigin(origin: string): boolean {
    return this.videasyOrigins.includes(origin) || /videasy\./i.test(origin || '');
  }

  private isRemoteIframeOrigin(origin: string): boolean {
    return (
      this.isVidfastOrigin(origin) ||
      this.isCinemaosOrigin(origin) ||
      this.isVidphantomOrigin(origin) ||
      this.isPeachifyOrigin(origin) ||
      this.isVidupOrigin(origin) ||
      this.isVideasyOrigin(origin) ||
      this.isMovies111Origin(origin)
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
      if (this.usesLocalHls && !this.serverPlaybackOk && !this.providerLockedByUser) {
        const failed = this.selectedProvider;
        const next = this.nextFailoverProvider(failed);
        if (next && this.switchProviderForFailover(next)) {
          this.providersTriedThisTitle.add(failed);
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
    if (!this.isRemoteIframeOrigin(event.origin || '')) {
      return;
    }

    // Videasy often posts a JSON string (progress / timestamp)
    let payload: unknown = event.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const envelope = payload as Record<string, unknown>;
    const type = envelope?.['type'] || envelope?.['eventType'] || envelope?.['event'];
    const data =
      (envelope?.['data'] as Record<string, unknown> | undefined) ??
      (envelope?.['payload'] as Record<string, unknown> | undefined) ??
      envelope;

    // Videasy progress payload: { id, type, progress, timestamp, duration, season, episode }
    if (
      this.isVideasyOrigin(event.origin || '') &&
      data &&
      typeof data === 'object' &&
      ('timestamp' in data || 'progress' in data) &&
      'duration' in data
    ) {
      const ts = Number((data as { timestamp?: number }).timestamp);
      const dur = Number((data as { duration?: number }).duration);
      this.onPlayerEvent({
        event: 'timeupdate',
        currentTime: Number.isFinite(ts) ? ts : this.currentTime,
        duration: Number.isFinite(dur) ? dur : this.duration,
        tmdbId: +this.id || 0,
        mediaType: this.mediaType === 'tv' ? 'tv' : 'movie',
        season: this.selectedSeason,
        episode: this.selectedEpisode,
        playing: this.isPlaying,
        muted: false,
        volume: 1,
      });
      return;
    }

    if (type === 'PLAYER_EVENT' && data) {
      const raw =
        data &&
        typeof data === 'object' &&
        'data' in data &&
        typeof (data as { data?: unknown }).data === 'object' &&
        (data as { data: { event?: unknown } }).data?.event != null
          ? ((data as { data: Record<string, unknown> }).data as Record<string, unknown>)
          : (data as Record<string, unknown>);
      const eventData = { ...(raw as unknown as PlayerEventData) };
      const name = String(eventData.event || raw['event'] || '').toLowerCase();
      if (name === 'time') {
        eventData.event = 'timeupdate';
      } else if (name === 'complete') {
        eventData.event = 'ended';
      } else if (
        name === 'play' ||
        name === 'pause' ||
        name === 'seeked' ||
        name === 'ended' ||
        name === 'timeupdate'
      ) {
        eventData.event = name;
      }
      if (typeof eventData.playing !== 'boolean') {
        const normalized = String(eventData.event || '').toLowerCase();
        if (normalized === 'play') {
          eventData.playing = true;
        } else if (normalized === 'pause' || normalized === 'ended') {
          eventData.playing = false;
        }
      }
      this.onPlayerEvent(eventData);
      this.cdr.detectChanges();
      return;
    }

    if (type === 'MEDIA_DATA' && data) {
      return;
    }

    if (type === 'PLAYER_NEXT_EPISODE') {
      this.nextEpisode();
      return;
    }

    const errorType = String(type || '').toLowerCase();
    if (
      errorType.includes('error') ||
      errorType === 'playback_error' ||
      errorType === 'player_error'
    ) {
      if (this.usesServerParam) {
        this.tryNextServerFailover();
      } else {
        const next = this.nextFailoverProvider(this.selectedProvider);
        if (next) {
          this.providersTriedThisTitle.add(this.selectedProvider);
          this.selectedProvider = next;
          this.reloadPlayer(this.currentTime, `Trying ${this.activeProviderLabel}…`);
        }
      }
      return;
    }

    const loose = data as unknown as PlayerEventData;
    if (
      data &&
      typeof data === 'object' &&
      ('currentTime' in data || 'event' in data) &&
      (loose.event || loose.playing !== undefined)
    ) {
      this.onPlayerEvent(loose);
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
    const peachifyLockPlaying = this.isPeachifyProvider && Date.now() < this.peachifyIgnorePlayingUntil;
    const movies111LockPlaying =
      this.isMovies111Provider && Date.now() < this.movies111IgnorePlayingUntil;
    if (typeof data.playing === 'boolean' && !peachifyLockPlaying && !movies111LockPlaying) {
      this.isPlaying = data.playing;
    }

    // Peachify may restore a different S/E from its own progress cache — pin ours
    if (this.reassertPeachifyEpisodeIfDrifted(data)) {
      return;
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
        if (!peachifyLockPlaying && !movies111LockPlaying) {
          this.isPlaying = true;
        }
        // CinemaOS forces muted=true on autoPlay — lift it as soon as playback starts
        if (this.isCinemaosProvider) {
          this.unmuteRemotePlayer();
        }
        this.broadcastWatchPartyEvent('play', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'pause':
        if (!peachifyLockPlaying && !movies111LockPlaying) {
          this.isPlaying = false;
        }
        this.broadcastWatchPartyEvent('pause', data.currentTime);
        this.persistLocalProgress(true);
        break;
      case 'ended':
        this.isPlaying = false;
        this.clearSeekGuard();
        this.persistLocalProgress(true);
        // Peachify auto-next is off — advance with Luscreens episode list
        if (this.isPeachifyProvider && this.mediaType === 'tv') {
          this.nextEpisode();
        }
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
   * - Peachify → URL reload (inbound postMessage disabled by host)
   * - Kean / Vidlove → SET_TIME seek; tap-to-play (unmuted); remount pause
   * - CinemaOS / VidFast / VidUP / Videasy → iframe postMessage `{ command }`
   */
  private postPlayerCommand(command: PlayerCommand, time?: number): void {
    if (this.usesLocalHls) {
      this.controlApiplayerVideo(command, time);
      return;
    }

    if (this.isPeachifyProvider) {
      this.controlPeachifyViaUrl(command, time);
      return;
    }

    if (this.isMovies111Provider) {
      this.controlKeanPlayer(command, time);
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

    const payload = this.toRemoteIframeCommand(command, time);
    contentWindow.postMessage(payload, '*');
  }

  /**
   * Live Vidlove inbound control:
   *   SET_TIME → seek (works unmuted)
   *   play → pass clicks through (Vidlove unmuted play path; autoplay=true always mutes)
   *   pause → remount with autoplay=false at current time
   */
  private controlKeanPlayer(command: PlayerCommand, time?: number): void {
    if (command === 'getStatus') {
      return;
    }

    const at = Math.max(0, Math.floor(time ?? this.currentTime));

    if (command === 'seek') {
      this.currentTime = at;
      this.lastSeekTarget = at;
      this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
      if (at <= 0) {
        this.movies111PendingSetTime = null;
        this.movies111WantAutoPlay = false;
        this.keanAwaitingGesturePlay = true;
        this.remountKeanEmbed(0, { showBootCover: false });
        return;
      }
      this.postKeanSetTime(at);
      return;
    }

    if (command === 'play') {
      // Do not remount with autoplay — that forces mute in Vidlove's player bundle.
      // Hide chrome so the next tap can reach Vidlove (required for sound on mobile).
      this.movies111WantAutoPlay = false;
      this.keanAwaitingGesturePlay = true;
      this.hidePlayerControls();
      return;
    }

    if (command === 'pause') {
      this.movies111WantAutoPlay = false;
      this.keanAwaitingGesturePlay = true;
      this.currentTime = at;
      this.lastSeekTarget = at;
      this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
      this.movies111IgnorePlayingUntil = Date.now() + 2800;
      this.movies111PendingSetTime = at > 0 ? at : null;
      this.remountKeanEmbed(at, { showBootCover: false });
    }
  }

  /** Vidlove: `{ type: 'SET_TIME', time }` or `{ type: 'SET_TIME', data: { time } }` (time must be > 0). */
  private postKeanSetTime(seconds: number): void {
    const win = this.playerIframe?.nativeElement?.contentWindow;
    if (!win || !Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    const time = Math.max(0.1, seconds);
    win.postMessage({ type: 'SET_TIME', time }, 'https://player.vidlove.cc');
    win.postMessage(
      { type: 'SET_TIME', data: { time } },
      'https://player.vidlove.cc'
    );
  }

  private clearKeanSetTimeTimers(): void {
    for (const timer of this.movies111SetTimeTimers) {
      clearTimeout(timer);
    }
    this.movies111SetTimeTimers = [];
  }

  /** After iframe load, retry SET_TIME until Vidlove's <video> has duration. */
  private flushKeanPendingSetTime(): void {
    this.clearKeanSetTimeTimers();
    const target = this.movies111PendingSetTime;
    if (target == null || target <= 0) {
      return;
    }

    const delays = [200, 600, 1200, 2200];
    for (const ms of delays) {
      this.movies111SetTimeTimers.push(
        setTimeout(() => {
          if (!this.isMovies111Provider) {
            return;
          }
          this.postKeanSetTime(target);
          if (ms === delays[delays.length - 1]) {
            this.movies111PendingSetTime = null;
          }
        }, ms)
      );
    }
  }

  private remountKeanEmbed(
    startAt: number,
    options: { showBootCover?: boolean } = {}
  ): void {
    if (!this.isMovies111Provider) {
      return;
    }
    if (this.movies111RemountTimer != null) {
      clearTimeout(this.movies111RemountTimer);
      this.movies111RemountTimer = null;
    }

    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;
    const showBootCover = options.showBootCover !== false;

    if (showBootCover) {
      this.beginKeanBootCover();
    } else {
      // Quiet remount (pause) — clear any leftover splash
      this.clearKeanBootCover();
    }
    this.showPlayerControls = true;
    this.destroyApiplayerVideo();

    this.playerSurfaceLocked = true;
    this.embedUrl = null;
    this.cdr.detectChanges();

    this.movies111RemountTimer = setTimeout(() => {
      this.movies111RemountTimer = null;
      if (!this.isMovies111Provider) {
        this.playerSurfaceLocked = false;
        return;
      }
      this.embedUrl = this.buildMovies111EmbedUrl(startAt);
      this.isPlaying = false;
      this.keanAwaitingGesturePlay = true;
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 30);
  }

  /** If Peachify's PLAYER_EVENT S/E ≠ our picker, force the embed path back. */
  private reassertPeachifyEpisodeIfDrifted(data: PlayerEventData): boolean {
    if (!this.isPeachifyProvider || this.mediaType !== 'tv') {
      return false;
    }
    const season = Math.floor(Number(data.season));
    const episode = Math.floor(Number(data.episode));
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return false;
    }
    if (season === this.selectedSeason && episode === this.selectedEpisode) {
      return false;
    }
    const now = Date.now();
    if (now < this.peachifyEpisodeReassertUntil) {
      return true;
    }
    this.peachifyEpisodeReassertUntil = now + 4000;
    this.peachifyWantAutoPlay = this.isPlaying || this.peachifyWantAutoPlay;
    this.embedUrl = this.buildPeachifyEmbedUrl(
      Math.max(0, Math.floor(this.currentTime))
    );
    this.cdr.detectChanges();
    return true;
  }

  /**
   * Peachify has no inbound command bridge — rebuild embed with autoPlay + startAt.
   * Must tear down the iframe (`embedUrl = null`) or browsers keep the old playback.
   * Do not touch `isPlaying` here — `togglePlayPause` already flips it once.
   */
  private controlPeachifyViaUrl(command: PlayerCommand, time?: number): void {
    if (command === 'getStatus') {
      return;
    }

    const at = Math.max(0, Math.floor(time ?? this.currentTime));

    if (command === 'play') {
      this.peachifyWantAutoPlay = true;
    } else if (command === 'pause') {
      this.peachifyWantAutoPlay = false;
    }

    this.currentTime = at;
    this.lastSeekTarget = at;
    this.seekGuardUntil = Date.now() + FrameComponent.SEEK_GUARD_MS;
    this.peachifyIgnorePlayingUntil = Date.now() + 2800;

    // Still try postMessage in case the host re-enables inbound control
    this.tryPeachifyPostMessage(command, at);

    if (this.peachifyControlTimer != null) {
      clearTimeout(this.peachifyControlTimer);
      this.peachifyControlTimer = null;
    }

    const delayMs = command === 'seek' ? 220 : 0;
    const apply = (): void => {
      this.peachifyControlTimer = null;
      this.remountPeachifyEmbed(at);
    };

    if (delayMs > 0) {
      this.peachifyControlTimer = setTimeout(apply, delayMs);
    } else {
      apply();
    }
  }

  /** Tear down + rebuild so `autoPlay` / `startAt` changes always take effect. */
  private remountPeachifyEmbed(startAt: number): void {
    if (!this.isPeachifyProvider) {
      return;
    }
    if (this.peachifyRemountTimer != null) {
      clearTimeout(this.peachifyRemountTimer);
      this.peachifyRemountTimer = null;
    }

    const stayFullscreen = this.isFullscreen || !!document.fullscreenElement;

    this.playerReloadLabel = 'Loading…';
    this.isPlayerReloading = true;
    this.showPlayerControls = true;
    this.armReloadOverlayTimeout();
    this.destroyApiplayerVideo();

    // Lock surface BEFORE clearing embedUrl so fullscreen container is not destroyed
    this.playerSurfaceLocked = true;
    this.embedUrl = null;
    this.cdr.detectChanges();

    this.peachifyRemountTimer = setTimeout(() => {
      this.peachifyRemountTimer = null;
      if (!this.isPeachifyProvider) {
        this.playerSurfaceLocked = false;
        return;
      }
      this.embedUrl = this.buildPeachifyEmbedUrl(startAt);
      this.isPlaying = this.peachifyWantAutoPlay;
      this.playerSurfaceLocked = false;
      this.cdr.detectChanges();
      this.ensureFullscreenPreserved(stayFullscreen);
    }, 30);
  }

  /** Re-enter fullscreen if a remount dropped the native fullscreen element. */
  private ensureFullscreenPreserved(shouldBeFullscreen: boolean): void {
    if (!shouldBeFullscreen) {
      return;
    }
    this.isFullscreen = true;
    const container = this.playerContainer?.nativeElement;
    if (!container) {
      this.syncKeanIframeFill();
      return;
    }
    if (document.fullscreenElement === container) {
      this.syncKeanIframeFill();
      return;
    }
    if (this.cssFullscreenFallback) {
      this.syncKeanIframeFill();
      return;
    }
    // Best-effort restore (may no-op without a user gesture on some browsers)
    void container.requestFullscreen?.().catch(() => {
      this.cssFullscreenFallback = true;
      this.isFullscreen = true;
      this.syncKeanIframeFill();
      this.cdr.detectChanges();
    });
  }

  private tryPeachifyPostMessage(command: PlayerCommand, time: number): void {
    const win = this.playerIframe?.nativeElement?.contentWindow;
    if (!win) {
      return;
    }
    const payloads: unknown[] = [
      { command },
      { command, time },
      { type: 'PLAYER_COMMAND', command, time },
      { type: 'command', command, time },
      JSON.stringify({ command }),
      JSON.stringify({ command, time }),
    ];
    if (command === 'seek') {
      payloads.push(
        { command: 'seek', time },
        { command: 'seek', value: time },
        { command: 'seek', seconds: time }
      );
    }
    for (const payload of payloads) {
      try {
        win.postMessage(payload, '*');
        win.postMessage(payload, 'https://peachify.top');
      } catch {
        // ignore cross-origin / closed frame
      }
    }
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
    if (!this.canControlPartyPlayback) {
      this.revealPlayerControls();
      return;
    }
    const nextPlaying = !this.isPlaying;
    // Peachify / Kean: set autoPlay intent before remount
    if (this.isPeachifyProvider) {
      this.peachifyWantAutoPlay = nextPlaying;
      this.isPlaying = nextPlaying;
      this.postPlayerCommand(nextPlaying ? 'play' : 'pause');
      this.onPlaybackStateChanged();
      return;
    }
    if (this.isMovies111Provider) {
      if (nextPlaying) {
        // Unmuted play: arm pass-through, hide Luscreens chrome, then user taps video.
        this.keanAwaitingGesturePlay = true;
        this.postPlayerCommand('play');
      } else {
        this.isPlaying = false;
        this.postPlayerCommand('pause');
        this.onPlaybackStateChanged();
      }
      return;
    }
    this.postPlayerCommand(nextPlaying ? 'play' : 'pause');
    // Optimistic UI so controls don't hide before the player event arrives
    this.isPlaying = nextPlaying;
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

  /**
   * One tap outside the center toggles controls (show ↔ hide).
   * Uses pointerup so mobile doesn't get mousemove-show + click-hide.
   */
  onPlayerSurfacePointerUp(event: PointerEvent): void {
    if (this.isPlayerReloading) {
      return;
    }
    // Don't steal taps meant for provider / server / CC menus
    if (this.showServerMenu || this.showProviderMenu || this.showCcMenu) {
      return;
    }
    // Center button handles play/pause; ignore bubbled pointerup from it
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.player-center-hit')) {
      return;
    }
    // Only primary button / touch / pen
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (Date.now() < this.controlsToggleSuppressedUntil) {
      return;
    }

    event.preventDefault();
    if (this.showPlayerControls) {
      this.hidePlayerControls();
      return;
    }
    this.revealPlayerControls();
    // Swallow the synthetic click that follows touch/pen
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  /** Center hit only: toggle play/pause. */
  onCenterPlayPauseTap(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.isPlayerReloading) {
      return;
    }
    this.revealPlayerControls();
    if (!this.canControlPartyPlayback) {
      return;
    }
    this.togglePlayPause();
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  /**
   * Hover: keep chrome alive while visible.
   * On fine pointers only, hover can reveal — but suppress the trailing click toggle.
   */
  onPlayerSurfaceMove(event?: MouseEvent): void {
    if (Date.now() < this.controlsToggleSuppressedUntil) {
      return;
    }
    if (this.showPlayerControls) {
      this.scheduleControlsHide();
      return;
    }
    // Touch devices synthesize mousemove before click — never auto-reveal there
    const finePointer =
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!finePointer) {
      return;
    }
    // Ignore moves with no buttons that are part of a drag; simple hover reveal
    if (event && event.buttons !== 0) {
      return;
    }
    this.revealPlayerControls();
    this.controlsToggleSuppressedUntil = Date.now() + 350;
  }

  revealPlayerControls(): void {
    this.showPlayerControls = true;
    this.scheduleControlsHide();
    this.cdr.detectChanges();
  }

  hidePlayerControls(): void {
    this.clearControlsHideTimer();
    this.showCcMenu = false;
    this.showProviderMenu = false;
    this.showServerMenu = false;
    this.showPlayerControls = false;
    // Ignore trailing mousemove / ghost click from the same gesture
    this.controlsToggleSuppressedUntil = Date.now() + 400;
    this.cdr.detectChanges();
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
    if (
      !this.isPlaying ||
      this.forceControlsVisible ||
      this.showCcMenu ||
      this.showProviderMenu ||
      this.showServerMenu
    ) {
      return;
    }
    this.controlsHideTimer = setTimeout(() => {
      if (
        this.isPlaying &&
        !this.forceControlsVisible &&
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
    // Guests may still apply host/sync remote seeks
    if (
      !this.canControlPartyPlayback &&
      !this.watchPartyService.isApplyingRemote
    ) {
      return;
    }
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
    if (!this.canControlPartyPlayback) {
      return;
    }
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
      if (document.fullscreenElement || this.cssFullscreenFallback || this.isFullscreen) {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        this.cssFullscreenFallback = false;
        this.isFullscreen = false;
        await this.syncFullscreenOrientation(false);
      } else {
        try {
          await container.requestFullscreen();
          this.cssFullscreenFallback = false;
          this.isFullscreen = true;
        } catch {
          // Mobile web (esp. iOS): element fullscreen often unsupported — CSS cover instead.
          this.cssFullscreenFallback = true;
          this.isFullscreen = true;
        }
        // Lock after enter so the user-gesture still counts on Android Chrome.
        await this.syncFullscreenOrientation(true);
      }
      this.updatePortraitViewport();
      this.syncKeanIframeFill();
      this.revealPlayerControls();
      // Fullscreen often opens while already playing — ensure the hide timer arms.
      if (this.isFullscreen && this.isPlaying) {
        this.onPlaybackStateChanged();
      }
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  }

  /** Cover-scale Kean iframe to the host box (works without container-query units). */
  private bindKeanFillObserver(): void {
    this.teardownKeanFillObserver();
    const host = this.keanFillHostEl;
    if (!host || !this.isMovies111Provider) {
      this.keanIframeFillStyle = { inset: '0', width: '100%', height: '100%' };
      return;
    }
    this.syncKeanIframeFill();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.keanFillObserver = new ResizeObserver(() => {
      this.ngZone.run(() => this.syncKeanIframeFill());
    });
    this.keanFillObserver.observe(host);
  }

  private teardownKeanFillObserver(): void {
    this.keanFillObserver?.disconnect();
    this.keanFillObserver = null;
  }

  private syncKeanIframeFill(): void {
    const host = this.keanFillHostEl;
    if (!host || !this.isMovies111Provider) {
      this.keanIframeFillStyle = { inset: '0', width: '100%', height: '100%' };
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) {
      return;
    }

    const target = 16 / 9;
    const hostRatio = w / h;
    // Already ~16:9 (inline player) — no cover zoom.
    if (Math.abs(hostRatio - target) < 0.04) {
      this.keanIframeFillStyle = { inset: '0', width: '100%', height: '100%' };
      return;
    }

    let iw: number;
    let ih: number;
    if (hostRatio > target) {
      iw = w;
      ih = w / target;
    } else {
      ih = h;
      iw = h * target;
    }
    const overscan = FrameComponent.KEAN_FILL_OVERSCAN;
    iw *= overscan;
    ih *= overscan;

    this.keanIframeFillStyle = {
      top: '50%',
      left: '50%',
      width: `${Math.round(iw)}px`,
      height: `${Math.round(ih)}px`,
      maxWidth: 'none',
      transform: 'translate(-50%, -50%) translateZ(0)',
      WebkitTransform: 'translate(-50%, -50%) translateZ(0)',
    };
  }

  private updatePortraitViewport(): void {
    if (typeof window === 'undefined') {
      this.isPortraitViewport = false;
      return;
    }
    this.isPortraitViewport = window.matchMedia('(orientation: portrait)').matches;
  }

  /**
   * Prefer real landscape lock (Capacitor + Screen Orientation API).
   * Mobile web (esp. iOS) often blocks lock — `forceLandscapeFullscreen` CSS covers that case.
   */
  private async syncFullscreenOrientation(fullscreen: boolean): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        if (fullscreen) {
          await ScreenOrientation.lock({ orientation: 'landscape' });
        } else {
          await ScreenOrientation.unlock();
        }
      } catch {
        // Orientation lock may be unavailable on some devices.
      }
      return;
    }

    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
      unlock?: () => void;
    };
    try {
      if (fullscreen) {
        if (typeof orientation?.lock === 'function') {
          await orientation.lock('landscape');
        }
      } else if (typeof orientation?.unlock === 'function') {
        orientation.unlock();
      }
    } catch {
      // Expected on iOS Safari / insecure contexts — CSS rotate fallback is used instead.
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
    if (!this.canControlPartyPlayback) {
      return;
    }
    const currentIndex = this.episodes.findIndex(
      (episode) => episode.episode_number === this.selectedEpisode
    );
    if (currentIndex > 0) {
      this.selectEpisode(this.episodes[currentIndex - 1].episode_number);
    }
  }

  nextEpisode(): void {
    if (!this.canControlPartyPlayback) {
      return;
    }
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
