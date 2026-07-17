import { Component, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { AuthService, AuthUser } from '../../services/auth.service';
import {
  ContinueWatchingItem,
  WatchProgressMap,
  WatchProgressService,
} from '../../services/watch-progress.service';

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

  isMenuOpen = false;
  isBrowseDropdownOpen = false;
  isAccountMenuOpen = false;
  isUsersModalOpen = false;
  isHomeRouteActive = false;
  isBrowseRouteActive = false;
  isAIRouteActive = false;

  name = '';
  email = '';
  password = '';
  rememberMe = true;
  authError = '';
  authLoading = false;

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
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.isBrowseRouteActive = event.url.startsWith('/browse');
        this.isHomeRouteActive = event.url === '/';
        this.isAIRouteActive = event.url === '/ai';
        this.closeAllDropdowns();
      }
    });
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
