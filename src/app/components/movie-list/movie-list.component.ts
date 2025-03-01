import { Component, OnInit, ViewChild, ElementRef,  } from '@angular/core';
import { NgForOf,CommonModule } from '@angular/common'; 
import { TmdbService } from '../../services/tmdb.service';
import { RouterModule, Router, NavigationEnd } from '@angular/router';

@Component({
  selector: 'app-movie-list',
  standalone: true,
  imports: [NgForOf, CommonModule, RouterModule], 
  templateUrl: './movie-list.component.html',
  styleUrls: ['./movie-list.component.css'],
})


export class MovieListComponent implements OnInit {
  movies: any[] = [];

  genresList = [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Science Fiction' },
    { id: 10770, name: 'TV Movie' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' },
  ];
  @ViewChild('carousel') carousel!: ElementRef;

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.tmdbService.getPopularMovies().subscribe((data: any) => {
      this.movies = data.results;
    });
  }
  scrollLeft() {
    this.carousel.nativeElement.scrollBy({ left: -200, behavior: 'smooth' });
  }

  
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  getGenres(genreIds: number[]): string {
    return genreIds
      .map((id) => this.genresList.find((genre) => genre.id === id)?.name)
      .filter((name) => !!name) 
      .join(', ');
  }
}
