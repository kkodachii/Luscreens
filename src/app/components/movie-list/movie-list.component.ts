import { Component, OnInit, ViewChild, ElementRef  } from '@angular/core';
import { NgForOf } from '@angular/common'; // Import NgForOf
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-list',
  standalone: true,
  imports: [NgForOf], // Add NgForOf here
  templateUrl: './movie-list.component.html',
  styleUrls: ['./movie-list.component.css'],
})


export class MovieListComponent implements OnInit {
  movies: any[] = [];
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

  // Scroll Right
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  
}
