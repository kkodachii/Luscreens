# AGENTS.md

## Cursor Cloud specific instructions

Luscreen is a **client-only Angular 19 SPA** (media streaming/discovery UI). There is no backend, database, or container in this repo — all data comes from external third-party APIs called directly from the browser (TMDB for metadata/images, VidFast for player embeds, Google Gemini for the AI recommendation page, and PeerJS's public broker for the Watch Party feature). **Internet access is required** for the app to show any content. API keys are hardcoded in `src/environments/environment.ts` and a few components, so no secrets/`.env` setup is needed.

### Services

Only one local service: the Angular dev server. Standard commands are in `package.json` and `README.md`; the notable ones:
- Run dev server: `npm start` (i.e. `ng serve`, http://localhost:4200). Component HMR is enabled by default.
- Dev build: `npm run build -- --configuration development` (the default `npm run build` uses the `production` config, which enforces bundle budgets).

### Testing / lint caveats
- **No lint is configured** — there is no `lint` script, no `lint` target in `angular.json`, and no ESLint config. Do not expect `ng lint` to work.
- `npm test` (`ng test`) uses Karma + Jasmine and needs a Chrome binary. In this headless VM run it with:
  `CHROME_BIN=$(which google-chrome) npx ng test --watch=false --browsers=ChromeHeadless`
- The 4 scaffolded spec files (`app.component.spec.ts`, `home`, `frame`, `ai`) currently **fail out of the box** (missing `ActivatedRoute`/`HttpClient` providers in the specs). These are pre-existing test bugs, not an environment problem — the Karma runner itself works.
