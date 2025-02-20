import { Component, OnInit } from '@angular/core';
import { NgForOf } from '@angular/common'; // Import NgForOf
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-list',
  standalone: true,
  imports: [NgForOf], // Add NgForOf here
  templateUrl: './movie-list.component.html',
})
export class MovieListComponent implements OnInit {
  movies: any[] = [];

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.tmdbService.getPopularMovies().subscribe((data: any) => {
      this.movies = data.results;
    });
  }
}