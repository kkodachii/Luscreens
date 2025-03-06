import { Routes } from '@angular/router';
import { BrowseComponent } from './components/browse/browse.component';
import { HomeComponent } from './components/home/home.component';
import { SearchComponent } from './components/search/search.component'; 
import { DetailsComponent } from './components/details/details.component';
import { FrameComponent } from './components/frame/frame.component'; 
import { AiComponent } from './components/ai/ai.component';

export const routes: Routes = [
  { path: '', component: HomeComponent }, 
  { path: 'browse/:type', component: BrowseComponent }, 
  { path: 'search', component: SearchComponent }, 
  { path: 'details/:media_type/:id', component: DetailsComponent },
  { path: 'frame/:media_type/:id', component: FrameComponent }, 
  { path: 'frame/:media_type/:id/:season/:episode', component: FrameComponent }, 
  { path: 'ai', component: AiComponent },
];