import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

@Injectable({
  providedIn: 'root',
})
export class CapacitorInitService {
  async init(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    document.documentElement.classList.add('capacitor-native');

    try {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.hide();
    } catch {
      // StatusBar is unavailable on some platforms/emulators.
    }

    try {
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
    } catch {
      // Keyboard plugin options differ by platform.
    }

    try {
      await SplashScreen.hide();
    } catch {
      // Splash may already be hidden.
    }

    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
        return;
      }
      App.exitApp();
    });
  }
}
