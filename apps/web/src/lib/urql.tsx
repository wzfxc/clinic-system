'use client';

import { createClient as createWsClient } from 'graphql-ws';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Client, Provider, cacheExchange, fetchExchange, subscriptionExchange } from 'urql';

const DEFAULT_API_URL = 'http://localhost:4000';

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;
}

export function createUrqlClient(baseUrl: string = apiBaseUrl()): Client {
  const httpUrl = `${baseUrl}/graphql`;
  const wsUrl = httpUrl.replace(/^http/, 'ws');
  // Subscriptions only exist in the browser; the WS upgrade carries the auth cookie.
  const wsClient = typeof window === 'undefined' ? null : createWsClient({ url: wsUrl, lazy: true });
  return new Client({
    url: httpUrl,
    fetchOptions: { credentials: 'include' },
    exchanges: [
      cacheExchange,
      fetchExchange,
      ...(wsClient
        ? [
            subscriptionExchange({
              forwardSubscription: (request) => ({
                subscribe: (sink) => ({
                  unsubscribe: wsClient.subscribe({ ...request, query: request.query ?? '' }, sink),
                }),
              }),
            }),
          ]
        : []),
    ],
  });
}

export function UrqlProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createUrqlClient(), []);
  return <Provider value={client}>{children}</Provider>;
}
