import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * OpenRouter chat client (OpenAI-compatible HTTP API).
 * Same endpoint/model as @openrouter/sdk — HttpClient works reliably in Angular browser apps.
 */
@Injectable({
  providedIn: 'root',
})
export class OpenRouterService {
  private readonly apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly model =
    environment.openRouterModel || 'google/gemma-4-26b-a4b-it:free';

  constructor(private http: HttpClient) {}

  chat(prompt: string, systemPrompt?: string): Observable<string> {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (systemPrompt?.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: prompt });
    return this.chatMessages(messages);
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
}
