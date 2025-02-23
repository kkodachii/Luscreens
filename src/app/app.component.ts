import { Component, AfterViewInit } from '@angular/core'; // Import AfterViewInit
import { HeaderComponent } from './components/header/header.component';
import { MovieListComponent } from './components/movie-list/movie-list.component';
import { MovieSeriesComponent } from './components/movie-series/movie-series.component';
import { TopRatedMovieSeriesComponent } from './components/top-rated/top-rated.component';
import { DiscoverMovieComponent } from './components/discover-movie/discover-movie.component';
import { initFlowbite } from 'flowbite'; // Import Flowbite 
import { HeroComponent } from './components/hero/hero.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HeaderComponent, MovieListComponent,HeroComponent, MovieSeriesComponent, TopRatedMovieSeriesComponent, DiscoverMovieComponent],
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