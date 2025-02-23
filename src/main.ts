import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import 'core-js/stable'; // Polyfills for modern JavaScript features
import 'regenerator-runtime/runtime'; // Polyfill for async/await

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
}).catch((err) => console.error(err));