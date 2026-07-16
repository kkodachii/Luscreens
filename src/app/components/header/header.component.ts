import { Component, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { AuthService } from '../../services/auth.service';

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

  isMenuOpen = false;
  isBrowseDropdownOpen = false;
  isAccountMenuOpen = false;
  isHomeRouteActive = false;
  isBrowseRouteActive = false;
  isAIRouteActive = false;

  name = '';
  email = '';
  password = '';
  authError = '';
  authLoading = false;

  readonly user = this.auth.user;
  readonly isLoggedIn = this.auth.isLoggedIn;
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
        ? this.auth.login({ email: this.email, password: this.password })
        : this.auth.register({
            email: this.email,
            password: this.password,
            name: this.name,
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
  }
}
