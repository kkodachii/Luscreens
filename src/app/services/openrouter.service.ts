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
    const parts = [
      'Recommend 1 to 5 real movie or TV show titles that exist on TMDB.',
      `User request: ${prompt}`,
      'Reply with ONLY a JSON array of title strings, like ["Inception","Interstellar"].',
      'No numbering, no markdown, no explanation.',
    ];
    if (excluded) {
      parts.push(`Do not suggest these titles: ${excluded}.`);
    }

    return this.chat(parts.join('\n')).pipe(
      map((text) => this.parseTitlesFromText(text)),
      catchError((err) => throwError(() => err))
    );
  }

  private parseTitlesFromText(text: string): string[] {
    let cleaned = String(text || '')
      .replace(/```(?:json|text)?\s*([\s\S]*?)```/gi, '$1')
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .trim();
    if (!cleaned) {
      return [];
    }

    const jsonMatch = cleaned.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          return this.normalizeTitleList(
            parsed.map((item) =>
              String(item || '')
                .replace(/\s*\(\d{4}\)\s*$/, '')
                .trim()
            )
          );
        }
      } catch {
        // fall through
      }
    }

    cleaned = cleaned.replace(/^\s*[-*\d.)]+\s*/gm, '');
    return this.normalizeTitleList(
      cleaned
        .split(/[\n,;|]+/)
        .map((part) =>
          part
            .replace(/^["'`]+|["'`]+$/g, '')
            .replace(/\s*\(\d{4}\)\s*$/, '')
            .replace(/^(?:title|movie|show)\s*:\s*/i, '')
            .trim()
        )
        .filter((t) => t && t.length < 120 && !/^here (are|is)\b/i.test(t))
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
