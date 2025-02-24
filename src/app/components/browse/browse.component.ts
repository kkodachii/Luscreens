import { Component, OnInit, HostListener,ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgForOf,CommonModule } from '@angular/common';
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-browse',
  standalone: true,
  imports: [NgForOf, CommonModule], // Add NgForOf here
  templateUrl: './browse.component.html',
  styleUrls: ['./browse.component.css'],
})
export class BrowseComponent implements OnInit {
  type: string = ''; // 'movie' or 'series'
  items: any[] = [];
  selectedGenreId: number | null = null; // Selected genre ID
  selectedFilter: string = 'popular'; // 'popular', 'rated', 'recent'
  isDropdownOpen: boolean = false; // Track dropdown visibility

  // Movie Genres
  movieGenres = [
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

  // TV Series Genres
  tvGenres = [
    { id: 10759, name: 'Action & Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 10762, name: 'Kids' },
    { id: 9648, name: 'Mystery' },
    { id: 10763, name: 'News' },
    { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 10766, name: 'Soap' },
    { id: 10767, name: 'Talk' },
    { id: 10768, name: 'War & Politics' },
    { id: 37, name: 'Western' },
  ];

  visibleGenres: any[] = []; // Genres displayed as buttons
  hiddenGenres: any[] = []; // Genres moved to the dropdown

  constructor(
    private route: ActivatedRoute,
    private tmdbService: TmdbService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Get the 'type' parameter from the route
    this.route.params.subscribe((params) => {
      this.type = params['type']; // 'movie' or 'series'
      this.fetchData(); // Fetch initial data
      this.calculateVisibleGenres();
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.calculateVisibleGenres(); // Recalculate visible genres on window resize
  }

  calculateVisibleGenres(): void {
    const genres = this.type === 'movie' ? this.movieGenres : this.tvGenres;
    const screenWidth = window.innerWidth;

    // Estimate the maximum number of genres that can fit based on screen width
    let maxVisibleGenres = Math.floor(screenWidth / 120); // Adjust 120 based on button width
    maxVisibleGenres = Math.max(1, Math.min(maxVisibleGenres, genres.length)); // Ensure at least 1 genre

    this.visibleGenres = genres.slice(0, maxVisibleGenres);
    this.hiddenGenres = genres.slice(maxVisibleGenres);
  }

  fetchData(): void {
    const genreId = this.selectedGenreId ?? undefined;
    this.tmdbService.getFilteredItems(this.type, this.selectedFilter, genreId).subscribe(
      (data: any) => {
        this.items = data.results;
        this.cdr.detectChanges(); // Trigger change detection
      },
      (error) => {
        console.error('Error fetching data:', error);
      }
    );
  }

  selectGenre(genreId: number): void {
    this.selectedGenreId = genreId; // Set the selected genre ID
    this.fetchData(); // Fetch data for the selected genre
    this.isDropdownOpen = false; // Close the dropdown after selecting a genre
  }

  applyFilter(filter: string): void {
    this.selectedFilter = filter; // Set the selected filter
    this.fetchData(); // Fetch data for the selected filter
  }

  toggleDropdown(): void {
    this.isDropdownOpen = !this.isDropdownOpen; // Toggle dropdown visibility
  }

  @HostListener('document:click', ['$event'])
  onClickOutside(event: MouseEvent): void {
    const dropdownButton = document.querySelector('.dropdown-button');
    if (
      dropdownButton &&
      !dropdownButton.contains(event.target as Node) &&
      this.isDropdownOpen
    ) {
      this.isDropdownOpen = false; // Close the dropdown if clicked outside
    }
  }
}