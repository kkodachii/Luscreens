import { Component, OnInit, ViewChild, ElementRef  } from '@angular/core';
import { NgForOf, CommonModule,NgIf} from '@angular/common'; 
import { TmdbService } from '../../services/tmdb.service';

@Component({
  selector: 'app-movie-series',
  standalone: true,
  imports: [NgForOf, CommonModule,NgIf], 
  templateUrl: './movie-series.component.html',
  styleUrls: ['./movie-series.component.css'],
})


export class MovieSeriesComponent implements OnInit {
  series: any[] = [];
  isLoading: boolean = true;
  showError: boolean = false;

  
  networks = [
    { id: 213, name: 'Netflix' },
    { id: 1024, name: 'Prime' },
    { id: 2739, name: 'Disney+' },
    { id: 49, name: 'HBO' },
    { id: 4330, name: 'Paramount+' },
  ];
  @ViewChild('carousel') carousel!: ElementRef;

  constructor(private tmdbService: TmdbService) {}

  selectedNetworkId: number = 213; 
  selectedNetworkName: string = 'Netflix'; 

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

  
  scrollRight() {
    this.carousel.nativeElement.scrollBy({ left: 200, behavior: 'smooth' });
  }
  
}
