import { Component } from '@angular/core';
import { MovieListComponent } from '../movie-list/movie-list.component';
import { MovieSeriesComponent } from '../movie-series/movie-series.component';
import { TopRatedMovieSeriesComponent } from '../top-rated/top-rated.component';
import { DiscoverMovieComponent } from '../discover-movie/discover-movie.component';
import { HeroComponent } from '../hero/hero.component';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [MovieListComponent,HeroComponent, MovieSeriesComponent, TopRatedMovieSeriesComponent, DiscoverMovieComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css'
})
export class HomeComponent {

}
