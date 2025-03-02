import { Component, AfterViewInit } from '@angular/core'; // Import AfterViewInit
import { HeaderComponent } from './components/header/header.component';
import { initFlowbite } from 'flowbite'; // Import Flowbite 
import { RouterModule,Router, NavigationEnd } from '@angular/router';

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
  constructor(private router: Router) {
    // Listen for route changes
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        // Check if the current route is the default route
        this.isDefaultRoute = event.url === '/';
        this.isHomeRouteActive = event.url === '/';
        this.isBrowseRouteActive = event.url.startsWith('/browse');
        this.isDetailsRoute = event.url.startsWith('/details');
        this.isFrameRoute = event.url.startsWith('/frame');
      }
    });
  }
  ngAfterViewInit(): void {
    // Initialize Flowbite after the view is fully initialized
    initFlowbite();
  }
}