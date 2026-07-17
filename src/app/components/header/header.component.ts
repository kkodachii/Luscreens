import { Component, DestroyRef, HostListener, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { AuthService, AuthUser } from '../../services/auth.service';
import {
  ContinueWatchingItem,
  WatchProgressMap,
  WatchProgressService,
} from '../../services/watch-progress.service';
import {
  WatchPartyMediaState,
  WatchPartyService,
  WatchPartyState,
} from '../../services/watch-party.service';
import { AiBubblePreferenceService } from '../../services/ai-bubble-preference.service';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.css'],
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
})
export class HeaderComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly watchProgress = inject(WatchProgressService);
  private readonly watchPartyService = inject(WatchPartyService);
  private readonly destroyRef = inject(DestroyRef);
  readonly aiBubblePref = inject(AiBubblePreferenceService);

  isMenuOpen = false;
  isBrowseDropdownOpen = false;
  isAccountMenuOpen = false;
  isUsersModalOpen = false;
  isJoinPartyModalOpen = false;
  isHomeRouteActive = false;
  isBrowseRouteActive = false;
  isAIRouteActive = false;

  name = '';
  email = '';
  password = '';
  rememberMe = true;
  authError = '';
  authLoading = false;

  joinRoomCode = '';
  joinPartyName = '';
  /** Prevents invite-link restore from reopening after the user taps Not now. */
  private dismissedInviteCode: string | null = null;
  watchParty: WatchPartyState = {
    role: null,
    roomCode: null,
    connected: false,
    connecting: false,
    members: [],
    error: null,
    inviteUrl: null,
  };

  adminUsers: AuthUser[] = [];
  adminUsersTotal = 0;
  adminUsersLoading = false;
  adminUsersError = '';

  selectedAdminUser: AuthUser | null = null;
  adminUserHistory: ContinueWatchingItem[] = [];
  adminUserHistoryLoading = false;
  adminUserHistoryError = '';
  adminUserLibraryUpdatedAt: number | null = null;

  readonly user = this.auth.user;
  readonly isLoggedIn = this.auth.isLoggedIn;
  readonly isAdmin = this.auth.isAdmin;
  readonly authModalOpen = this.auth.authModalOpen;
  readonly authModalMode = this.auth.authModalMode;

  constructor() {
    this.watchPartyService.state$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.watchParty = state;
        if (state.connected) {
          this.isJoinPartyModalOpen = false;
        }
      });

    this.watchPartyService.joinModal$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((modal) => {
        if (!modal.open || this.watchParty.connected) {
          this.isJoinPartyModalOpen = false;
          return;
        }
        const code = (modal.code || '').toUpperCase();
        if (code && this.dismissedInviteCode === code) {
          this.watchPartyService.closeJoinModal();
          return;
        }
        if (modal.code) {
          this.joinRoomCode = modal.code;
        }
        this.isJoinPartyModalOpen = true;
      });

    this.watchPartyService.remoteCommands$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((command) => {
        if (
          command.media &&
          this.watchPartyService.snapshot.role === 'guest'
        ) {
          this.navigateToPartyMedia(command.media);
        }
      });

    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event instanceof NavigationEnd) {
          this.isBrowseRouteActive = event.url.startsWith('/browse');
          this.isHomeRouteActive = event.url === '/';
          this.isAIRouteActive = event.url === '/ai';
          this.closeAllDropdowns();
          this.openJoinFromQueryParam(event.urlAfterRedirects || event.url);
        }
      });
  }

  get isAuthGuest(): boolean {
    return !this.auth.isLoggedIn();
  }

  getWatchPartyDisplayName(fallback: string): string {
    const accountName = this.auth.user()?.name?.trim();
    if (accountName) {
      return accountName;
    }
    return this.joinPartyName.trim() || fallback;
  }

  openJoinPartyModal(): void {
    this.closeAllDropdowns();
    this.dismissedInviteCode = null;
    this.watchPartyService.openJoinModal(this.joinRoomCode || undefined);
  }

  closeJoinPartyModal(): void {
    this.dismissedInviteCode = (this.joinRoomCode || '').trim().toUpperCase() || null;
    this.watchPartyService.closeJoinModal();
    this.isJoinPartyModalOpen = false;
  }

  async joinWatchParty(): Promise<void> {
    const joinInput = this.joinRoomCode;
    const mediaFromInvite = this.parseMediaFromInviteInput(joinInput);

    try {
      await this.watchPartyService.joinParty(
        joinInput,
        this.getWatchPartyDisplayName('Guest')
      );
      this.closeJoinPartyModal();

      // If they pasted a full /frame/...?party= invite, go there right away
      if (mediaFromInvite) {
        this.navigateToPartyMedia(mediaFromInvite);
      }

      // Then follow the host's live media (may refine season/episode/title)
      const media =
        (await this.watchPartyService.waitForMediaState(
          mediaFromInvite ? 2500 : 4500
        )) || this.watchPartyService.getMediaState();

      if (media) {
        this.navigateToPartyMedia(media);
      }
    } catch (error) {
      console.error('Failed to join watch party:', error);
      this.isJoinPartyModalOpen = true;
    }
  }

  private openJoinFromQueryParam(url: string): void {
    if (this.watchParty.connected || this.watchParty.connecting) {
      return;
    }
    try {
      const tree = this.router.parseUrl(url);
      const party = String(tree.queryParams['party'] || '').trim();
      if (party) {
        this.watchPartyService.openJoinModal(party);
      }
    } catch {
      // ignore bad URLs
    }
  }

  /**
   * If the user pasted a full invite link (/frame/...?party=CODE), recover the
   * media path so we can navigate even before the host media packet arrives.
   */
  private parseMediaFromInviteInput(input: string): WatchPartyMediaState | null {
    const raw = (input || '').trim();
    if (!raw || !/party=/i.test(raw)) {
      return null;
    }

    try {
      const url = new URL(raw, window.location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      // /frame/:mediaType/:id[/:season/:episode]
      if (parts[0] !== 'frame' || parts.length < 3) {
        return null;
      }

      const mediaType = parts[1];
      const id = parts[2];
      if (!mediaType || !id) {
        return null;
      }

      const season = parts[3] != null ? Number(parts[3]) : undefined;
      const episode = parts[4] != null ? Number(parts[4]) : undefined;

      return {
        mediaType,
        id,
        season: Number.isFinite(season) ? season : undefined,
        episode: Number.isFinite(episode) ? episode : undefined,
      };
    } catch {
      return null;
    }
  }

  private navigateToPartyMedia(media: WatchPartyMediaState): void {
    if (!media?.mediaType || media.id == null || media.id === '') {
      return;
    }

    const roomCode =
      this.watchPartyService.snapshot.roomCode || this.watchParty.roomCode;
    const queryParams = roomCode ? { party: roomCode } : {};

    const target =
      media.mediaType === 'tv' && media.season && media.episode
        ? ['/frame', media.mediaType, media.id, media.season, media.episode]
        : ['/frame', media.mediaType, media.id];

    const currentPath = this.router.url.split('?')[0];
    const targetPath = this.router.createUrlTree(target).toString();
    if (currentPath === targetPath) {
      // Same title — still ensure party query param is present
      if (roomCode && !this.router.parseUrl(this.router.url).queryParams['party']) {
        void this.router.navigate([], {
          queryParams: { party: roomCode },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      }
      return;
    }

    void this.router.navigate(target, { queryParams });
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.isAccountMenuOpen = false;
  }

  get apiEnabled(): boolean {
    return this.auth.enabled;
  }

  toggleMenu(): void {
    this.isBrowseDropdownOpen = false;
    this.isAccountMenuOpen = false;
    this.isMenuOpen = !this.isMenuOpen;
  }

  toggleBrowseDropdown(): void {
    this.isMenuOpen = false;
    this.isAccountMenuOpen = false;
    this.isBrowseDropdownOpen = !this.isBrowseDropdownOpen;
  }

  toggleAccountMenu(event: Event): void {
    event.stopPropagation();
    this.isMenuOpen = false;
    this.isBrowseDropdownOpen = false;
    this.isAccountMenuOpen = !this.isAccountMenuOpen;
  }

  closeAllDropdowns(): void {
    this.isMenuOpen = false;
    this.isBrowseDropdownOpen = false;
    this.isAccountMenuOpen = false;
  }

  toggleAiBubbleShortcut(): void {
    this.aiBubblePref.toggleHidden();
  }

  openLoginModal(): void {
    this.closeAllDropdowns();
    this.authError = '';
    this.password = '';
    this.auth.openAuthModal('login');
  }

  openSignUpModal(): void {
    this.closeAllDropdowns();
    this.authError = '';
    this.password = '';
    this.auth.openAuthModal('register');
  }

  closeAuthModal(): void {
    this.auth.closeAuthModal();
    this.authError = '';
    this.authLoading = false;
  }

  setAuthMode(mode: 'login' | 'register'): void {
    this.auth.setAuthModalMode(mode);
    this.authError = '';
  }

  submitAuth(): void {
    this.authError = '';
    this.authLoading = true;
    const mode = this.authModalMode();

    const req$ =
      mode === 'login'
        ? this.auth.login({
            email: this.email,
            password: this.password,
            rememberMe: this.rememberMe,
          })
        : this.auth.register({
            email: this.email,
            password: this.password,
            name: this.name,
            rememberMe: this.rememberMe,
          });

    req$.subscribe((result) => {
      this.authLoading = false;
      if (!result.ok) {
        this.authError = result.error;
        return;
      }
      this.password = '';
      this.closeAuthModal();
    });
  }

  logout(): void {
    this.auth.logout();
    this.closeAllDropdowns();
    this.closeUsersModal();
  }

  openUsersModal(): void {
    if (!this.isAdmin()) {
      return;
    }
    this.closeAllDropdowns();
    this.isUsersModalOpen = true;
    this.loadAdminUsers();
  }

  closeUsersModal(): void {
    this.isUsersModalOpen = false;
    this.adminUsersError = '';
    this.closeAdminUserHistory();
  }

  loadAdminUsers(): void {
    this.adminUsersLoading = true;
    this.adminUsersError = '';
    this.auth.listUsers().subscribe((result) => {
      this.adminUsersLoading = false;
      if (!result.ok) {
        this.adminUsersError = result.error;
        this.adminUsers = [];
        this.adminUsersTotal = 0;
        return;
      }
      this.adminUsers = result.users;
      this.adminUsersTotal = result.total;
    });
  }

  openAdminUserHistory(user: AuthUser, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.isAdmin() || !user?.id) {
      return;
    }
    this.selectedAdminUser = user;
    this.adminUserHistory = [];
    this.adminUserHistoryError = '';
    this.adminUserLibraryUpdatedAt = null;
    this.adminUserHistoryLoading = true;

    this.auth.getUserLibraryAdmin(user.id).subscribe((result) => {
      this.adminUserHistoryLoading = false;
      if (!result.ok) {
        this.adminUserHistoryError = result.error;
        this.adminUserHistory = [];
        return;
      }
      this.selectedAdminUser = result.user || user;
      this.adminUserLibraryUpdatedAt = result.library.updatedAt ?? null;
      this.adminUserHistory = this.watchProgress.getContinueWatchingFromMap(
        (result.library.progress || {}) as WatchProgressMap,
        100
      );
    });
  }

  closeAdminUserHistory(): void {
    this.selectedAdminUser = null;
    this.adminUserHistory = [];
    this.adminUserHistoryLoading = false;
    this.adminUserHistoryError = '';
    this.adminUserLibraryUpdatedAt = null;
  }

  formatJoinedDate(createdAt: number | undefined): string {
    if (!createdAt) {
      return '—';
    }
    try {
      return new Date(createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  formatHistoryTime(seconds: number): string {
    return this.watchProgress.formatTime(seconds);
  }

  formatLastWatched(timestamp: number): string {
    if (!timestamp) {
      return '';
    }
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }
}
