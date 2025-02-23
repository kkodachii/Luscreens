import { Component, OnInit, ViewChild, ElementRef  } from '@angular/core';
import { NgForOf } from '@angular/common'; // Import NgForOf
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-series',
  standalone: true,
  imports: [NgForOf], // Add NgForOf here
  templateUrl: './movie-series.component.html',
  styleUrls: ['./movie-series.component.css'],
})


export class MovieSeriesComponent implements OnInit {
  series: any[] = [];
  isLoading: boolean = true;
  showError: boolean = false;

  // Network mapping
  networks = [
    { id: 213, name: 'Netflix' },
    { id: 1024, name: 'Prime' },
    { id: 2739, name: 'Disney+' },
    { id: 49, name: 'HBO' },
    { id: 4330, name: 'Paramount+' },
  ];
  @ViewChild('carousel') carousel!: ElementRef;

  constructor(private tmdbService: TmdbService) {}

  selectedNetworkId: number = 213; // Default to Netflix
  selectedNetworkName: string = 'Netflix'; // Default network name

  ngOnInit(): void {
    this.loadSeries(this.selectedNetworkId);
  }

  loadSeries(networkId: number): void {
    this.isLoading = true;
    this.showError = false;

    this.tmdbService.getPopularSeriesByNetwork(networkId).subscribe(
      (data: any) => {
        this.series = data.results;
        this.isLoading = false;

        // Update the selected network name
        const selectedNetwork = this.networks.find((n) => n.id === networkId);
        if (selectedNetwork) {
          this.selectedNetworkName = selectedNetwork.name;
        }
      },
      (error) => {
        console.error('Error fetching series:', error);
        this.isLoading = false;
        this.showError = true;
      }
    );
  }

  selectNetwork(networkId: number): void {
    this.selectedNetworkId = networkId;
    this.loadSeries(networkId);
  }

  scrollLeft() {
    this.carousel.nativeElement.scrollBy({ left: -200, behavior: 'smooth' });
  }

  // Scroll Right
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  
}
