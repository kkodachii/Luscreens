import { Component, OnInit, ViewChild, ElementRef  } from '@angular/core';
import { NgForOf, CommonModule,NgIf } from '@angular/common'; 
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-top-rated',
  standalone: true,
  imports: [NgForOf, CommonModule,NgIf], 
  templateUrl: './top-rated.component.html',
  styleUrls: ['./top-rated.component.css'],
})


export class TopRatedMovieSeriesComponent implements OnInit {
  items: any[] = [];
  isLoading: boolean = true;
  showError: boolean = false;

  navOptions = ['Movies', 'Series'];
  selectedOption: string = 'Movies';

  @ViewChild('carousel') carousel!: ElementRef;

  constructor(private tmdbService: TmdbService) {}

  ngOnInit(): void {
    this.loadItems(this.selectedOption);
  }

  loadItems(option: string): void {
    this.isLoading = true;
    this.showError = false;

    if (option === 'Movies') {
  this.tmdbService.getTopRatedMovies().subscribe(
    (data: any) => {
      this.items = data.results.slice(0, 30); 
      this.isLoading = false;
    },
    (error) => {
      console.error('Error fetching top-rated movies:', error);
      this.isLoading = false;
      this.showError = true;
    }
  );
} else if (option === 'Series') {
  this.tmdbService.getTopRatedSeries().subscribe(
    (data: any) => {
      this.items = data.results.slice(0, 30); 
      this.isLoading = false;
    },
    (error) => {
      console.error('Error fetching top-rated series:', error);
      this.isLoading = false;
      this.showError = true;
    }
  );
}
}

selectOption(option: string): void {
  this.selectedOption = option;
  this.loadItems(option);
}

  scrollLeft() {
    this.carousel.nativeElement.scrollBy({ left: -200, behavior: 'smooth' });
  }

  
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  
}
