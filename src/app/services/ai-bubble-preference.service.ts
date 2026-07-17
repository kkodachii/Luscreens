import { Injectable, signal } from '@angular/core';

/**
 * Mobile AI floating shortcut preference.
 * Persists across sessions so users can hide it and turn it back on from the menu.
 */
@Injectable({ providedIn: 'root' })
export class AiBubblePreferenceService {
  private static readonly HIDDEN_KEY = 'luscreensAiBubbleHidden';

  readonly isHidden = signal(this.readHidden());

  setHidden(hidden: boolean): void {
    this.isHidden.set(hidden);
    try {
      localStorage.setItem(
        AiBubblePreferenceService.HIDDEN_KEY,
        hidden ? '1' : '0'
      );
    } catch {
      // ignore
    }
  }

  toggleHidden(): void {
    this.setHidden(!this.isHidden());
  }

  private readHidden(): boolean {
    try {
      return localStorage.getItem(AiBubblePreferenceService.HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  }
}
