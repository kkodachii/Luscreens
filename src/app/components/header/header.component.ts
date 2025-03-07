import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.css'],
  standalone: true,
  imports: [CommonModule, RouterModule],
})
export class HeaderComponent {
  isMenuOpen: boolean = false;
  isBrowseDropdownOpen: boolean = false;
  isHomeRouteActive: boolean = false;
  isBrowseRouteActive: boolean = false;
  isAIRouteActive: boolean = false;

  constructor(private router: Router) {
    
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        
        this.isBrowseRouteActive = event.url.startsWith('/browse');
        this.isHomeRouteActive = event.url === '/';
        this.isAIRouteActive = event.url === '/ai';

        
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
}