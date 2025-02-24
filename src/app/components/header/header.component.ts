import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  standalone: true,
  imports: [CommonModule, RouterModule],
})
export class HeaderComponent {
  isMenuOpen: boolean = false;
  isBrowseDropdownOpen: boolean = false;
  isHomeRouteActive: boolean = false;
  isBrowseRouteActive: boolean = false;

  constructor(private router: Router) {
    // Listen for route changes
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        // Check if the current route starts with '/browse'
        this.isBrowseRouteActive = event.url.startsWith('/browse');
        this.isHomeRouteActive = event.url === '/';

        // Close all dropdowns when navigation occurs
        this.closeAllDropdowns();
      }
    });
  }

  toggleMenu(): void {
    // Close the Browse dropdown if it's open
    this.isBrowseDropdownOpen = false;
    // Toggle the burger menu
    this.isMenuOpen = !this.isMenuOpen;
  }

  toggleBrowseDropdown(): void {
    // Close the burger menu if it's open
    this.isMenuOpen = false;
    // Toggle the Browse dropdown
    this.isBrowseDropdownOpen = !this.isBrowseDropdownOpen;
  }

  closeAllDropdowns(): void {
    // Close both the burger menu and the Browse dropdown
    this.isMenuOpen = false;
    this.isBrowseDropdownOpen = false;
  }
}