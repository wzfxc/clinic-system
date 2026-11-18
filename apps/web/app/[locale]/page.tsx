import { setRequestLocale } from 'next-intl/server';
import { Suspense, use } from 'react';
import { ClinicApp } from '../../src/components/ClinicApp';

export default function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense fallback={<div className="p-8">Loading...</div>}>
      <ClinicApp locale={locale} />
    </Suspense>
  );
}
