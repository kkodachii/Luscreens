import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  mode: 'login' | 'register' = 'login';
  name = '';
  email = '';
  password = '';
  error = '';
  loading = false;

  get apiEnabled(): boolean {
    return this.auth.enabled;
  }

  setMode(mode: 'login' | 'register'): void {
    this.mode = mode;
    this.error = '';
  }

  submit(): void {
    this.error = '';
    this.loading = true;

    const req$ =
      this.mode === 'login'
        ? this.auth.login({ email: this.email, password: this.password })
        : this.auth.register({
            email: this.email,
            password: this.password,
            name: this.name,
          });

    req$.subscribe((result) => {
      this.loading = false;
      if (!result.ok) {
        this.error = result.error;
        return;
      }
      void this.router.navigateByUrl('/');
    });
  }
}
