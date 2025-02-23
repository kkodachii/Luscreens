import { Routes } from '@angular/router';
import { BrowseComponent } from './components/browse/browse.component';
import { HomeComponent } from './components/home/home.component';


export const routes: Routes = [
    { path: '', component: HomeComponent }, 
{ path: 'browse/:type', component: BrowseComponent }, 
];