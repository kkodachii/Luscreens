import { ApplicationConfig } from '@angular/core';
import { provideRouter, RouterModule } from '@angular/router';
import { importProvidersFrom } from '@angular/core';
import { routes } from './app.routes'; // Import your routes
import { HttpClientModule } from '@angular/common/http'; // Import HttpClientModule

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes), // Provide routes
    importProvidersFrom(RouterModule.forRoot(routes)), // Include RouterModule
    importProvidersFrom(HttpClientModule), // Provide HttpClientModule
  ],
};