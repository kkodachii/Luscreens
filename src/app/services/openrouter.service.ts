import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, map, throwError } from 'rxjs';
import { environment } from '../../environments/environment';

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * OpenRouter chat client (OpenAI-compatible HTTP API).
 * Prefers the auth-api proxy (`OPENROUTER_API_KEY` on Render) so the key is not
 * required in the Angular bundle. Falls back to `environment.openRouterApiKey`.
 */
@Injectable({
  providedIn: 'root',
})
export class OpenRouterService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly model =
    environment.openRouterModel || 'openrouter/free';
  private readonly authApiUrl = (environment.authApiUrl || '').replace(/\/$/, '');

  chat(prompt: string, systemPrompt?: string): Observable<string> {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (systemPrompt?.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: prompt });
    return this.chatMessages(messages);
  }

  /**
   * Ask the model for 1–5 real movie/TV titles matching a natural-language prompt.
   */
  recommendTitles(prompt: string, exclude: string[] = []): Observable<string[]> {
    const cleanedPrompt = prompt.trim();
    if (!cleanedPrompt) {
      return throwError(() => new Error('Enter a prompt'));
    }

    if (this.authApiUrl) {
      return this.http
        .post<{ titles?: string[] }>(`${this.authApiUrl}/ai/recommend`, {
          prompt: cleanedPrompt,
          exclude: exclude.filter(Boolean).slice(0, 20),
        })
        .pipe(
          map((res) => this.normalizeTitleList(res?.titles || [])),
          catchError((err) => {
            // 503 = server has no key — try browser key next
            const status = (err as { status?: number })?.status;
            if (status === 503 || status === 404) {
              return this.recommendTitlesViaClient(cleanedPrompt, exclude);
            }
            const message =
              (err as { error?: { error?: string } })?.error?.error ||
              (err as { message?: string })?.message ||
              'AI recommendation failed';
            return throwError(() => new Error(message));
          })
        );
    }

    return this.recommendTitlesViaClient(cleanedPrompt, exclude);
  }

  chatMessages(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  ): Observable<string> {
    const apiKey = environment.openRouterApiKey;
    if (!apiKey) {
      return throwError(() => new Error('OpenRouter API key is missing'));
    }

    const headers = new HttpHeaders({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer':
        typeof window !== 'undefined' ? window.location.origin : 'https://luscreens.app',
      'X-Title': 'Luscreens',
    });

    return this.http
      .post<OpenRouterChatResponse>(
        this.apiUrl,
        {
          model: this.model,
          messages,
          stream: false,
        },
        { headers }
      )
      .pipe(
        map((response) => {
          const content = response?.choices?.[0]?.message?.content?.trim();
          if (!content) {
            throw new Error(response?.error?.message || 'No response from OpenRouter');
          }
          return content;
        }),
        catchError((error) => {
          const message =
            error?.error?.error?.message ||
            error?.error?.message ||
            error?.message ||
            'OpenRouter request failed';
          console.error('OpenRouter error:', error);
          return throwError(() => new Error(message));
        })
      );
  }

  private recommendTitlesViaClient(
    prompt: string,
    exclude: string[]
  ): Observable<string[]> {
    if (!environment.openRouterApiKey) {
      return throwError(
        () =>
          new Error(
            'AI is not configured. Set OPENROUTER_API_KEY on the auth API, or openRouterApiKey in environment.'
          )
      );
    }

    const excluded = exclude.filter(Boolean).join(', ');
    const system =
      'You recommend real movie and TV titles that exist on TMDB. Reply with 1 to 5 titles only, comma-separated. No numbering, no quotes, no explanation.';
    let user = `Suggest existing movie or TV show titles matching: "${prompt}"`;
    if (excluded) {
      user += ` Do not suggest: ${excluded}.`;
    }

    return this.chat(user, system).pipe(
      map((text) => this.parseTitlesFromText(text)),
      catchError((err) => throwError(() => err))
    );
  }

  private parseTitlesFromText(text: string): string[] {
    const cleaned = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*[-*\d.)]+\s*/gm, '')
      .trim();
    if (!cleaned) {
      return [];
    }
    return this.normalizeTitleList(
      cleaned
        .split(/[\n,;|]+/)
        .map((part) => part.replace(/^["'`]+|["'`]+$/g, '').trim())
        .filter(Boolean)
    );
  }

  private normalizeTitleList(titles: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of titles) {
      const title = String(raw || '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();
      if (!title) {
        continue;
      }
      const key = title.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(title);
      if (out.length >= 5) {
        break;
      }
    }
    return out;
  }
}
