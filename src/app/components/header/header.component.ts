import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-header',
  templateUrl: './header.component.html',
  standalone: true,
  imports: [CommonModule],
})
export class HeaderComponent {
  isMenuOpen: boolean = false;
  isBrowseDropdownOpen: boolean = false;

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
}