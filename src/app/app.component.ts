import { Component, AfterViewInit, inject } from '@angular/core'; // Import AfterViewInit
import { HeaderComponent } from './components/header/header.component';
import { initFlowbite } from 'flowbite'; // Import Flowbite 
import { RouterModule,Router, NavigationEnd } from '@angular/router';
import { UserLibraryService } from './services/user-library.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterModule, HeaderComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements AfterViewInit {
  title = 'web-app';
  isBrowseRouteActive: boolean = false;
  isDefaultRoute: boolean = true;
  isHomeRouteActive: boolean = false;
  isDetailsRoute: boolean = false;
  isFrameRoute: boolean = false;
  isAiRoute: boolean = false;

  /** Ensures user-scoped library sync starts with the app. */
  private readonly _userLibrary = inject(UserLibraryService);

  constructor(private router: Router) {
    // Listen for route changes
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const url = event.urlAfterRedirects || event.url;
        // Check if the current route is the default route
        this.isDefaultRoute = url === '/' || url.startsWith('/?');
        this.isHomeRouteActive = this.isDefaultRoute;
        this.isBrowseRouteActive = url.startsWith('/browse');
        this.isDetailsRoute = url.startsWith('/details');
        this.isFrameRoute = url.startsWith('/frame');
        this.isAiRoute = url.startsWith('/ai');
        this.resetScrollPosition();
      }
    });
  }
  resetScrollPosition(): void {
    // Reset the scroll position of the custom scrollbar container
    const container = document.querySelector('.custom-scrollbar');
    if (container) {
      container.scrollTop = 0; // Scroll to the top
    }
  }
  ngAfterViewInit(): void {
    // Initialize Flowbite after the view is fully initialized
    initFlowbite();
  }
}