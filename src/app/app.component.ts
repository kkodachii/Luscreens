import { Component, AfterViewInit } from '@angular/core'; // Import AfterViewInit
import { HeaderComponent } from './components/header/header.component';
import { MovieListComponent } from './components/movie-list/movie-list.component';
import { initFlowbite } from 'flowbite'; // Import Flowbite 
import { HeroComponent } from './components/hero/hero.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HeaderComponent, MovieListComponent,  HeroComponent ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements AfterViewInit {
  title = 'web-app';

  ngAfterViewInit(): void {
    // Initialize Flowbite after the view is fully initialized
    initFlowbite();
  }
}