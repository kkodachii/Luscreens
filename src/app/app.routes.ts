import { Routes } from '@angular/router';
import { BrowseComponent } from './components/browse/browse.component';
import { HomeComponent } from './components/home/home.component';
import { SearchComponent } from './components/search/search.component'; // Import the standalone 
import { DetailsComponent } from './components/details/details.component';

export const routes: Routes = [
  { path: '', component: HomeComponent }, // Home route
  { path: 'browse/:type', component: BrowseComponent }, // Browse route
  { path: 'search', component: SearchComponent }, // Search route
  { path: 'details/:media_type/:id', component: DetailsComponent },
];