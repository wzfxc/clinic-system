import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { routing } from '../../src/i18n/routing';
import { UrqlProvider } from '../../src/lib/urql';
import '../globals.css';

export const metadata = { title: 'Clinic' };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <UrqlProvider>{children}</UrqlProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
