import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.css'],
  standalone: true,
  imports: [CommonModule, RouterModule],
})
export class HeaderComponent {
  private readonly auth = inject(AuthService);

  isMenuOpen = false;
  isBrowseDropdownOpen = false;
  isHomeRouteActive = false;
  isBrowseRouteActive = false;
  isAIRouteActive = false;
  isLoginRouteActive = false;

  readonly user = this.auth.user;
  readonly isLoggedIn = this.auth.isLoggedIn;

  constructor(private router: Router) {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.isBrowseRouteActive = event.url.startsWith('/browse');
        this.isHomeRouteActive = event.url === '/';
        this.isAIRouteActive = event.url === '/ai';
        this.isLoginRouteActive = event.url.startsWith('/login');
        this.closeAllDropdowns();
      }
    });
  }

  toggleMenu(): void {
    this.isBrowseDropdownOpen = false;
    this.isMenuOpen = !this.isMenuOpen;
  }

  toggleBrowseDropdown(): void {
    this.isMenuOpen = false;
    this.isBrowseDropdownOpen = !this.isBrowseDropdownOpen;
  }

  closeAllDropdowns(): void {
    this.isMenuOpen = false;
    this.isBrowseDropdownOpen = false;
  }

  logout(): void {
    this.auth.logout();
    this.closeAllDropdowns();
    if (this.router.url.startsWith('/login')) {
      void this.router.navigateByUrl('/');
    }
  }
}
