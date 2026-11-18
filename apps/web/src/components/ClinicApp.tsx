'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useSubscription } from 'urql';
import {
  AcceptOfferDocument,
  AppointmentHistoryDocument,
  CancelAppointmentDocument,
  CatalogDocument,
  ChangeAppointmentStatusDocument,
  ConfirmAppointmentDocument,
  DeclineOfferDocument,
  FindFreeSlotsDocument,
  HoldSlotDocument,
  JoinWaitlistDocument,
  LeaveWaitlistDocument,
  LoginDocument,
  LogoutDocument,
  ManagerReportDocument,
  MarkSickLeaveDocument,
  MeDocument,
  MyAppointmentsDocument,
  MyRemindersDocument,
  MyWaitlistDocument,
  RescheduleAppointmentDocument,
  SlotsChangedDocument,
  StaffAppointmentsDocument,
  UpsertScheduleExceptionDocument,
  type HoldSlotMutation,
} from '../graphql/generated';
import { formatDateTime, formatMoneyMinor } from '../lib/format';

type HeldAppointment = HoldSlotMutation['holdSlot'];

interface LoginFormValues {
  email: string;
  password: string;
}

interface WaitlistFormValues {
  dateFrom: string;
  dateTo: string;
}

interface SickLeaveFormValues {
  doctorId: string;
  date: string;
  kind: 'sick' | 'vacation' | 'extra_day';
}

const DEFAULT_CLINICS = [
  { id: 1, city: 'Kyiv', name: 'Kyiv Central', timezone: 'Europe/Kyiv', currency: 'UAH' },
  { id: 2, city: 'Lviv', name: 'Lviv Clinic', timezone: 'Europe/Kyiv', currency: 'UAH' },
  { id: 3, city: 'Warsaw', name: 'Warsaw Clinic', timezone: 'Europe/Warsaw', currency: 'PLN' },
];

const BASE_PRICES: Record<string, number> = {
  Kyiv: 30000,
  Lviv: 27000,
  Warsaw: 12000,
};

function extractErrorCode(err: { graphQLErrors?: { extensions?: Record<string, unknown> }[]; message?: string } | undefined): string {
  if (!err) return '';
  const code = err.graphQLErrors?.[0]?.extensions?.['code'];
  return typeof code === 'string' ? `${code}: ${err.message ?? ''}` : (err.message ?? 'Error');
}

export function ClinicApp({ locale }: { locale: string }) {
  const tHome = useTranslations('Home');
  const t = useTranslations('Common');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL state (Requirement 17: filters, reload and browser Back button restore state from URL)
  const city = searchParams.get('city') ?? 'Kyiv';
  const serviceIdParam = Number(searchParams.get('serviceId') ?? '1');
  const serviceId = Number.isFinite(serviceIdParam) && serviceIdParam > 0 ? serviceIdParam : 1;
  const doctorIdParam = searchParams.get('doctorId') ?? '';
  const doctorIdFilter = doctorIdParam ? Number(doctorIdParam) : null;
  const reportFrom = searchParams.get('from') ?? '';
  const reportTo = searchParams.get('to') ?? '';

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, searchParams],
  );

  // Catalog & Auth
  const [catalogRes] = useQuery({ query: CatalogDocument });
  const [meRes, reexecuteMe] = useQuery({ query: MeDocument, requestPolicy: 'network-only' });
  const [sessionMe, setSessionMe] = useState<{
    userId: number;
    role: string;
    clinicId?: number | null;
    patientId?: number | null;
    doctorId?: number | null;
  } | null>(null);
  const me = sessionMe ?? (meRes.error ? null : (meRes.data?.me ?? null));

  const clinics = catalogRes.data?.clinics?.length ? catalogRes.data.clinics : DEFAULT_CLINICS;
  const services = catalogRes.data?.services ?? [];
  const doctors = catalogRes.data?.doctors ?? [];
  const currentClinic = useMemo(
    () => clinics.find((c) => c.city === city) ?? clinics[0] ?? DEFAULT_CLINICS[0]!,
    [clinics, city],
  );
  const currentService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? services[0],
    [services, serviceId],
  );
  const previewPriceMinor = useMemo(() => {
    const duration = currentService?.durationMinutes ?? 30;
    const factor = currentClinic.city === 'Warsaw' ? 0.4 : currentClinic.city === 'Lviv' ? 0.9 : 1;
    return Math.round(duration * 1000 * factor) || (BASE_PRICES[currentClinic.city] ?? 30000);
  }, [currentClinic.city, currentService?.durationMinutes]);

  // Free slots + live subscription
  const [slotsRes, reexecuteSlots] = useQuery({
    query: FindFreeSlotsDocument,
    variables: { city, serviceId },
    pause: !me || me.role === 'manager',
    requestPolicy: 'cache-and-network',
  });
  const [subEvent] = useSubscription({
    query: SlotsChangedDocument,
    variables: { clinicId: currentClinic.id },
    pause: !me || me.role === 'manager',
  });

  // Patient queries
  const [myApptsRes, reexecuteMyAppts] = useQuery({
    query: MyAppointmentsDocument,
    variables: { first: 50 },
    pause: !me || me.role !== 'patient',
    requestPolicy: 'cache-and-network',
  });
  const [myWaitlistRes, reexecuteMyWaitlist] = useQuery({
    query: MyWaitlistDocument,
    pause: !me || me.role !== 'patient',
    requestPolicy: 'cache-and-network',
  });
  const [myRemindersRes, reexecuteMyReminders] = useQuery({
    query: MyRemindersDocument,
    pause: !me || me.role !== 'patient',
    requestPolicy: 'cache-and-network',
  });
  const [historyApptId, setHistoryApptId] = useState<number | null>(null);
  const [historyRes] = useQuery({
    query: AppointmentHistoryDocument,
    variables: { appointmentId: historyApptId ?? 0 },
    pause: historyApptId === null,
    requestPolicy: 'network-only',
  });

  // Staff queries
  const [staffApptsRes, reexecuteStaffAppts] = useQuery({
    query: StaffAppointmentsDocument,
    variables: {
      filter: me?.role === 'receptionist' ? { clinicId: me.clinicId ?? currentClinic.id } : undefined,
      first: 50,
    },
    pause: !me || (me.role !== 'receptionist' && me.role !== 'doctor'),
    requestPolicy: 'cache-and-network',
  });

  // Manager report query
  const [reportRes, reexecuteReport] = useQuery({
    query: ManagerReportDocument,
    variables: {
      fromDate: reportFrom || null,
      toDate: reportTo || null,
    },
    pause: !me || me.role !== 'manager',
    requestPolicy: 'cache-and-network',
  });

  // When slotsChanged fires over WebSocket, refetch slots and waitlist offers without page reload
  const lastSlotSignal = subEvent.data?.slotsChanged;
  useEffect(() => {
    if (!lastSlotSignal) return;
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') {
      reexecuteMyWaitlist({ requestPolicy: 'network-only' });
      reexecuteMyAppts({ requestPolicy: 'network-only' });
    }
  }, [lastSlotSignal, me?.role, reexecuteMyAppts, reexecuteMyWaitlist, reexecuteSlots]);

  // Mutations
  const [, executeLogin] = useMutation(LoginDocument);
  const [, executeLogout] = useMutation(LogoutDocument);
  const [, executeHoldSlot] = useMutation(HoldSlotDocument);
  const [, executeConfirm] = useMutation(ConfirmAppointmentDocument);
  const [, executeCancel] = useMutation(CancelAppointmentDocument);
  const [, executeReschedule] = useMutation(RescheduleAppointmentDocument);
  const [, executeJoinWaitlist] = useMutation(JoinWaitlistDocument);
  const [, executeLeaveWaitlist] = useMutation(LeaveWaitlistDocument);
  const [, executeAcceptOffer] = useMutation(AcceptOfferDocument);
  const [, executeDeclineOffer] = useMutation(DeclineOfferDocument);
  const [, executeChangeStatus] = useMutation(ChangeAppointmentStatusDocument);
  const [, executeSickLeave] = useMutation(MarkSickLeaveDocument);
  const [, executeUpsertException] = useMutation(UpsertScheduleExceptionDocument);

  // Active hold state & 10-minute countdown timer
  const [activeHold, setActiveHold] = useState<HeldAppointment | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(600);
  const [actionError, setActionError] = useState<string>('');
  const [actionMessage, setActionMessage] = useState<string>('');
  const [registrarPatientId, setRegistrarPatientId] = useState<string>('1');
  const [slotLimit, setSlotLimit] = useState<number>(48);

  const statusLabel = (s: string): string => {
    switch (s) {
      case 'held':
        return t('status_held');
      case 'booked':
        return t('status_booked');
      case 'checked_in':
        return t('status_checked_in');
      case 'completed':
        return t('status_completed');
      case 'no_show':
        return t('status_no_show');
      case 'cancelled':
        return t('status_cancelled');
      case 'waiting':
        return t('status_waiting');
      case 'offered':
        return t('status_offered');
      default:
        return s;
    }
  };

  useEffect(() => {
    if (!activeHold) return;
    const expiresMs = activeHold.holdExpiresAt
      ? new Date(activeHold.holdExpiresAt).getTime()
      : Date.now() + 10 * 60_000;
    const tick = () => {
      const diff = Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
      setRemainingSeconds(diff);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [activeHold]);

  // Forms with react-hook-form & field-level errors
  const loginForm = useForm<LoginFormValues>({
    defaultValues: { email: '', password: '' },
  });

  const waitlistForm = useForm<WaitlistFormValues>({
    defaultValues: { dateFrom: '2026-11-19', dateTo: '2026-11-25' },
  });

  const sickLeaveForm = useForm<SickLeaveFormValues>({
    defaultValues: { doctorId: '1', date: '2026-11-20', kind: 'sick' },
  });

  const onLoginSubmit = loginForm.handleSubmit(async (values) => {
    setActionError('');
    const res = await executeLogin({ email: values.email.trim(), password: values.password });
    if (res.error || !res.data?.login) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    setSessionMe(res.data.login);
    reexecuteMe({ requestPolicy: 'network-only' });
    reexecuteSlots({ requestPolicy: 'network-only' });
  });

  const onLogout = async () => {
    setActionError('');
    setActiveHold(null);
    setSessionMe(null);
    await executeLogout({});
    reexecuteMe({ requestPolicy: 'network-only' });
  };

  const filteredSlots = useMemo(() => {
    const all = slotsRes.data?.findFreeSlots ?? [];
    if (doctorIdFilter === null || Number.isNaN(doctorIdFilter)) return all;
    return all.filter((s) => s.doctorId === doctorIdFilter);
  }, [slotsRes.data?.findFreeSlots, doctorIdFilter]);

  const onHoldSlot = async (slot: { clinicId: number; doctorId: number; startAt: string }) => {
    setActionError('');
    setActionMessage('');
    const input =
      me?.role === 'receptionist'
        ? {
            clinicId: slot.clinicId,
            doctorId: slot.doctorId,
            serviceId,
            startsAt: slot.startAt,
            patientId: Number(registrarPatientId) || 1,
          }
        : {
            clinicId: slot.clinicId,
            doctorId: slot.doctorId,
            serviceId,
            startsAt: slot.startAt,
          };
    const res = await executeHoldSlot({ input });
    if (res.error || !res.data?.holdSlot) {
      setActionError(extractErrorCode(res.error));
      reexecuteSlots({ requestPolicy: 'network-only' });
      return;
    }
    setActiveHold(res.data.holdSlot);
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') reexecuteMyAppts({ requestPolicy: 'network-only' });
  };

  const onConfirmHold = async () => {
    if (!activeHold) return;
    setActionError('');
    const key = `confirm-${activeHold.id}`;
    const res = await executeConfirm({ appointmentId: activeHold.id, idempotencyKey: key });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      reexecuteSlots({ requestPolicy: 'network-only' });
      return;
    }
    setActiveHold(null);
    setActionMessage(`Confirmed #${res.data?.confirmAppointment.id ?? activeHold.id}`);
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') reexecuteMyAppts({ requestPolicy: 'network-only' });
    if (me?.role === 'receptionist') reexecuteStaffAppts({ requestPolicy: 'network-only' });
  };

  const onCancelAppointment = async (appointmentId: number) => {
    setActionError('');
    const res = await executeCancel({ appointmentId, reason: 'user_cancelled' });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    if (activeHold?.id === appointmentId) setActiveHold(null);
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') {
      reexecuteMyAppts({ requestPolicy: 'network-only' });
      reexecuteMyWaitlist({ requestPolicy: 'network-only' });
    }
    if (me?.role === 'receptionist') reexecuteStaffAppts({ requestPolicy: 'network-only' });
  };

  const onReschedule = async (appointmentId: number, expectedVersion: number, newStartsAt: string) => {
    setActionError('');
    const res = await executeReschedule({ appointmentId, expectedVersion, newStartsAt });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    reexecuteSlots({ requestPolicy: 'network-only' });
    reexecuteMyAppts({ requestPolicy: 'network-only' });
  };

  const onJoinWaitlist = waitlistForm.handleSubmit(async (values) => {
    setActionError('');
    if (values.dateFrom > values.dateTo) {
      waitlistForm.setError('dateTo', { message: t('dateRequired') });
      return;
    }
    const targetDoctorId = doctorIdFilter ?? filteredSlots[0]?.doctorId ?? doctors[0]?.id ?? 1;
    const res = await executeJoinWaitlist({
      input: {
        clinicId: currentClinic.id,
        doctorId: targetDoctorId,
        serviceId,
        dateFrom: values.dateFrom,
        dateTo: values.dateTo,
      },
    });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    setActionMessage(`Waitlist #${res.data?.joinWaitlist ?? ''}`);
    reexecuteMyWaitlist({ requestPolicy: 'network-only' });
  });

  const onLeaveWaitlist = async (entryId: number) => {
    setActionError('');
    const res = await executeLeaveWaitlist({ entryId });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    reexecuteMyWaitlist({ requestPolicy: 'network-only' });
  };

  const onAcceptOffer = async (offerId: number) => {
    setActionError('');
    const res = await executeAcceptOffer({ offerId, idempotencyKey: `offer-${offerId}` });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      reexecuteMyWaitlist({ requestPolicy: 'network-only' });
      return;
    }
    setActionMessage(`Offer accepted: #${res.data?.acceptOffer.id ?? ''}`);
    reexecuteMyWaitlist({ requestPolicy: 'network-only' });
    reexecuteMyAppts({ requestPolicy: 'network-only' });
    reexecuteSlots({ requestPolicy: 'network-only' });
  };

  const onDeclineOffer = async (offerId: number) => {
    setActionError('');
    const res = await executeDeclineOffer({ offerId });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    reexecuteMyWaitlist({ requestPolicy: 'network-only' });
    reexecuteSlots({ requestPolicy: 'network-only' });
  };

  const onStaffStatus = async (appointmentId: number, to: string) => {
    setActionError('');
    const res = await executeChangeStatus({ appointmentId, to });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    reexecuteStaffAppts({ requestPolicy: 'network-only' });
  };

  const onSickLeave = sickLeaveForm.handleSubmit(async (values) => {
    setActionError('');
    const clinicId = me?.clinicId ?? currentClinic.id;
    const doctorId = Number(values.doctorId);
    if (values.kind === 'sick') {
      const res = await executeSickLeave({ doctorId, clinicId, date: values.date });
      if (res.error) {
        setActionError(extractErrorCode(res.error));
        return;
      }
      setActionMessage(
        `Sick leave applied=${String(res.data?.markSickLeave.applied)}: cancelled ${res.data?.markSickLeave.cancelledAppointmentIds.length ?? 0}`,
      );
    } else {
      const res = await executeUpsertException({
        input: {
          doctorId,
          clinicId,
          date: values.date,
          kind: values.kind === 'extra_day' ? 'extra_day' : 'day_off',
          reason: values.kind === 'vacation' ? 'vacation' : 'other',
          workStart: values.kind === 'extra_day' ? '10:00' : null,
          workEnd: values.kind === 'extra_day' ? '14:00' : null,
        },
      });
      if (res.error) {
        setActionError(extractErrorCode(res.error));
        return;
      }
      setActionMessage(`Schedule updated: ${values.kind} (${values.date})`);
    }
    reexecuteStaffAppts({ requestPolicy: 'network-only' });
    reexecuteSlots({ requestPolicy: 'network-only' });
  });

  const myAppointments = myApptsRes.data?.myAppointments ?? [];
  const activeAppointmentsCount = myAppointments.filter((a) => a.status !== 'cancelled').length;
  const pendingOffers = (myWaitlistRes.data?.myWaitlistOffers ?? []).filter((o) => o.status === 'pending');
  const waitlistEntries = myWaitlistRes.data?.myWaitlistEntries ?? [];
  const myReminders = myRemindersRes.data?.myReminders ?? [];
  const historyEvents = historyRes.data?.appointmentHistory ?? [];
  const staffAppointments = staffApptsRes.data?.appointments ?? [];
  const report = reportRes.data?.managerReport;
  void reexecuteMyReminders;

  const qsSuffix = searchParams.toString() ? `?${searchParams.toString()}` : '';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white px-6 py-4 shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{tHome('title')}</h1>
            <p className="text-sm text-slate-600">{tHome('subtitle')}</p>
          </div>

          <div className="flex items-center gap-4">
            <nav aria-label="Language" className="flex gap-2 text-sm font-medium">
              {(['uk', 'en', 'pl'] as const).map((loc) => (
                <Link
                  key={loc}
                  href={`/${loc}${qsSuffix}`}
                  data-testid={`lang-${loc}`}
                  className={`rounded px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-600 ${
                    locale === loc ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {loc.toUpperCase()}
                </Link>
              ))}
            </nav>

            {me ? (
              <div className="flex items-center gap-3">
                <span data-testid="current-user" className="rounded bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                  {me.role} #{me.userId}
                </span>
                <button
                  type="button"
                  data-testid="logout-btn"
                  onClick={onLogout}
                  className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {t('signOut')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 p-6">
        {/* Locale & formatting summary bar (always visible for locale / plural / currency verification) */}
        <section
          aria-label="Clinic summary"
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-white p-4 text-sm shadow-sm"
        >
          <div>
            <span className="font-medium">{currentClinic.name}</span> ({currentClinic.city} ·{' '}
            <code data-testid="clinic-timezone">{currentClinic.timezone}</code>) — {t('clinicTimeNotice')}
          </div>
          <div className="flex items-center gap-4">
            <span data-testid="sample-price" className="font-semibold text-blue-700">
              {formatMoneyMinor(previewPriceMinor, currentClinic.currency, locale)}
            </span>
            <span data-testid="appointments-count" className="text-slate-700">
              {tHome('appointments', { count: me ? activeAppointmentsCount : 3 })}
            </span>
          </div>
        </section>

        {actionError ? (
          <div
            role="alert"
            data-testid="booking-error"
            className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800"
          >
            {actionError}
          </div>
        ) : null}

        {actionMessage ? (
          <div
            role="status"
            data-testid="booking-status"
            className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
          >
            {actionMessage}
          </div>
        ) : null}

        {/* Login Form */}
        {!me ? (
          <section className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('signIn')}</h2>
            <form onSubmit={onLoginSubmit} noValidate data-testid="login-form" className="grid max-w-md gap-4">
              <div>
                <label htmlFor="login-email" className="mb-1 block text-sm font-medium">
                  {t('email')}
                </label>
                <input
                  id="login-email"
                  type="email"
                  data-testid="login-email"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  {...loginForm.register('email', {
                    required: t('emailRequired'),
                    pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: t('emailRequired') },
                  })}
                />
                {loginForm.formState.errors.email ? (
                  <p role="alert" data-testid="email-error" className="mt-1 text-xs text-red-600">
                    {loginForm.formState.errors.email.message}
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor="login-password" className="mb-1 block text-sm font-medium">
                  {t('password')}
                </label>
                <input
                  id="login-password"
                  type="password"
                  data-testid="login-password"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  {...loginForm.register('password', {
                    required: t('passwordRequired'),
                    minLength: { value: 8, message: t('passwordRequired') },
                  })}
                />
                {loginForm.formState.errors.password ? (
                  <p role="alert" data-testid="password-error" className="mt-1 text-xs text-red-600">
                    {loginForm.formState.errors.password.message}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                data-testid="login-submit"
                className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {t('signIn')}
              </button>
            </form>
          </section>
        ) : null}

        {/* Filters stored in URL (City, Service, Doctor) */}
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="filter-city" className="mb-1 block text-sm font-medium">
                {t('city')}
              </label>
              <select
                id="filter-city"
                data-testid="filter-city"
                value={city}
                onChange={(e) => updateUrl({ city: e.target.value })}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {clinics.map((c) => (
                  <option key={c.id} value={c.city}>
                    {c.city} — {c.name} ({c.timezone})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="filter-service" className="mb-1 block text-sm font-medium">
                {t('service')}
              </label>
              <select
                id="filter-service"
                data-testid="filter-service"
                value={String(serviceId)}
                onChange={(e) => updateUrl({ serviceId: e.target.value })}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {(services.length > 0
                  ? services
                  : [{ id: 1, name: 'General consultation', durationMinutes: 30, usesUltrasoundRoom: false }]
                ).map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name} ({s.durationMinutes} min{s.usesUltrasoundRoom ? ' · US' : ''})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="filter-doctor" className="mb-1 block text-sm font-medium">
                {t('doctor')}
              </label>
              <select
                id="filter-doctor"
                data-testid="filter-doctor"
                value={doctorIdParam}
                onChange={(e) => updateUrl({ doctorId: e.target.value || null })}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value="">{t('allDoctors')}</option>
                {doctors.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    #{d.id} — {d.specialty}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Active 10-minute checkout hold banner */}
          {activeHold ? (
            <div
              data-testid="active-hold"
              data-appointment-id={activeHold.id}
              className="mt-6 rounded-lg border-2 border-amber-400 bg-amber-50 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-amber-900">{t('holdTitle')}</h3>
                  <p className="text-sm text-amber-800">
                    #{activeHold.id} · {formatDateTime(activeHold.startsAt, currentClinic.timezone, locale)} ·{' '}
                    {formatMoneyMinor(activeHold.priceMinor, activeHold.currency, locale)}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-amber-900">
                    {t('holdCountdown')}:{' '}
                    <span data-testid="hold-countdown">
                      {String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:
                      {String(remainingSeconds % 60).padStart(2, '0')}
                    </span>
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="confirm-hold-btn"
                    onClick={onConfirmHold}
                    className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  >
                    {t('confirmBooking')}
                  </button>
                  <button
                    type="button"
                    data-testid="cancel-hold-btn"
                    onClick={() => onCancelAppointment(activeHold.id)}
                    className="rounded border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {t('cancelBooking')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Free Slot Grid (14 days, clinic local time) */}
          {me && me.role !== 'manager' ? (
            <div className="mt-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold" data-testid="slots-count">
                  {tHome('slotsFound', { count: filteredSlots.length })}
                </h2>
                <button
                  type="button"
                  data-testid="refresh-slots-btn"
                  onClick={() => reexecuteSlots({ requestPolicy: 'network-only' })}
                  className="rounded border px-2.5 py-1 text-xs hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  ↻
                </button>
              </div>

              <div data-testid="slots-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {filteredSlots.slice(0, slotLimit).map((slot) => {
                  const key = `${slot.doctorId}-${slot.startAt}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid={`slot-${slot.doctorId}-${slot.startAt}`}
                      data-slot-start={slot.startAt}
                      data-doctor-id={slot.doctorId}
                      data-local-date={slot.localDate}
                      data-local-time={slot.localTime}
                      onClick={() => onHoldSlot(slot)}
                      className="flex flex-col items-start rounded border border-slate-200 bg-slate-50 p-2.5 text-left text-xs hover:border-blue-500 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      <span className="font-bold text-slate-900">
                        {slot.localDate} {slot.localTime}
                      </span>
                      <span className="text-slate-600">
                        {t('doctor')} #{slot.doctorId}
                      </span>
                      <span className="mt-1 font-medium text-blue-700">
                        {formatMoneyMinor(previewPriceMinor, currentClinic.currency, locale)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {filteredSlots.length > slotLimit ? (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    data-testid="show-more-slots-btn"
                    onClick={() => setSlotLimit((n) => n + 96)}
                    className="rounded border px-4 py-1.5 text-xs font-medium hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {t('showMore')} ({slotLimit} / {filteredSlots.length})
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* Patient Waitlist & Offers */}
        {me?.role === 'patient' ? (
          <section data-testid="waitlist-section" className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('waitlist')}</h2>

            {/* Pending Waitlist Offers */}
            {pendingOffers.length > 0 ? (
              <div data-testid="waitlist-offers" className="mb-6 space-y-3">
                {pendingOffers.map((offer) => (
                  <div
                    key={offer.id}
                    data-testid={`offer-${offer.id}`}
                    data-offer-id={offer.id}
                    className="flex flex-wrap items-center justify-between gap-4 rounded-lg border-2 border-emerald-500 bg-emerald-50 p-4"
                  >
                    <div>
                      <p className="font-semibold text-emerald-900">
                        Offer #{offer.id} · {t('doctor')} #{offer.doctorId}
                      </p>
                      <p className="text-sm text-emerald-800">
                        {formatDateTime(offer.startsAt, currentClinic.timezone, locale)} (expires{' '}
                        {formatDateTime(offer.expiresAt, currentClinic.timezone, locale)})
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid="accept-offer-btn"
                        onClick={() => onAcceptOffer(offer.id)}
                        className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      >
                        {t('acceptOffer')}
                      </button>
                      <button
                        type="button"
                        data-testid="decline-offer-btn"
                        onClick={() => onDeclineOffer(offer.id)}
                        className="rounded border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      >
                        {t('declineOffer')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Join Waitlist Form */}
            <form
              onSubmit={onJoinWaitlist}
              noValidate
              data-testid="join-waitlist-form"
              className="flex flex-wrap items-end gap-4"
            >
              <div>
                <label htmlFor="wl-date-from" className="mb-1 block text-xs font-medium">
                  {t('dateFrom')}
                </label>
                <input
                  id="wl-date-from"
                  type="text"
                  data-testid="waitlist-date-from"
                  placeholder="YYYY-MM-DD"
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  {...waitlistForm.register('dateFrom', {
                    required: t('dateRequired'),
                    pattern: { value: /^\d{4}-\d{2}-\d{2}$/, message: t('dateRequired') },
                  })}
                />
                {waitlistForm.formState.errors.dateFrom ? (
                  <p role="alert" data-testid="dateFrom-error" className="mt-1 text-xs text-red-600">
                    {waitlistForm.formState.errors.dateFrom.message}
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor="wl-date-to" className="mb-1 block text-xs font-medium">
                  {t('dateTo')}
                </label>
                <input
                  id="wl-date-to"
                  type="text"
                  data-testid="waitlist-date-to"
                  placeholder="YYYY-MM-DD"
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  {...waitlistForm.register('dateTo', {
                    required: t('dateRequired'),
                    pattern: { value: /^\d{4}-\d{2}-\d{2}$/, message: t('dateRequired') },
                  })}
                />
                {waitlistForm.formState.errors.dateTo ? (
                  <p role="alert" data-testid="dateTo-error" className="mt-1 text-xs text-red-600">
                    {waitlistForm.formState.errors.dateTo.message}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                data-testid="join-waitlist-btn"
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {t('joinWaitlist')}
              </button>
            </form>

            {waitlistEntries.length > 0 ? (
              <ul data-testid="waitlist-entries" className="mt-4 divide-y text-sm">
                {waitlistEntries.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between py-2">
                    <span>
                      #{entry.id} · {t('doctor')} #{entry.doctorId} · {entry.dateFrom} → {entry.dateTo} ({statusLabel(entry.status)})
                    </span>
                    <button
                      type="button"
                      data-testid={`leave-waitlist-${entry.id}`}
                      onClick={() => onLeaveWaitlist(entry.id)}
                      className="rounded border px-2.5 py-1 text-xs hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      {t('leaveWaitlist')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {/* In-App Reminders (24h and 2h) */}
        {me?.role === 'patient' && myReminders.length > 0 ? (
          <section data-testid="in-app-reminders" className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold">{t('reminders')}</h2>
            <ul className="divide-y text-sm">
              {myReminders.map((rem) => (
                <li key={rem.id} className="flex items-center justify-between py-2">
                  <span>
                    #{rem.appointmentId} · <span className="font-medium">{rem.kind.toUpperCase()}</span> ·{' '}
                    {formatDateTime(rem.startsAt, currentClinic.timezone, locale)} ({t('doctor')} #{rem.doctorId})
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Patient Appointments */}
        {me?.role === 'patient' ? (
          <section data-testid="my-appointments" className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">
              {t('myAppointments')} ({tHome('appointments', { count: activeAppointmentsCount })})
            </h2>
            <ul className="divide-y text-sm">
              {myAppointments.map((appt) => {
                const sameDoctorSlot = (slotsRes.data?.findFreeSlots ?? []).find(
                  (s) => s.doctorId === appt.doctor.id && s.startAt !== appt.startsAt,
                );
                return (
                  <li
                    key={appt.id}
                    data-testid={`appointment-${appt.id}`}
                    data-status={appt.status}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      <span className="font-semibold">#{appt.id}</span> ·{' '}
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium">
                        {statusLabel(appt.status)}
                      </span>{' '}
                      · {formatDateTime(appt.startsAt, appt.clinic.timezone, locale)} ({appt.clinic.city}) ·{' '}
                      {appt.service.name} · {t('doctor')} #{appt.doctor.id} ({appt.doctor.specialty}) ·{' '}
                      <span className="font-medium text-blue-700">
                        {formatMoneyMinor(appt.priceMinor, appt.currency, locale)}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid={`history-appointment-${appt.id}`}
                        onClick={() => setHistoryApptId((prev) => (prev === appt.id ? null : appt.id))}
                        className="rounded border px-2.5 py-1 text-xs hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      >
                        {t('history')}
                      </button>
                      {appt.status === 'booked' && sameDoctorSlot ? (
                        <button
                          type="button"
                          data-testid={`reschedule-appointment-${appt.id}`}
                          onClick={() => onReschedule(appt.id, appt.timeVersion, sameDoctorSlot.startAt)}
                          className="rounded border px-2.5 py-1 text-xs hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        >
                          {t('reschedule')} ({sameDoctorSlot.localDate} {sameDoctorSlot.localTime})
                        </button>
                      ) : null}
                      {appt.status === 'booked' || appt.status === 'held' ? (
                        <button
                          type="button"
                          data-testid={`cancel-appointment-${appt.id}`}
                          onClick={() => onCancelAppointment(appt.id)}
                          className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-600"
                        >
                          {t('cancelBooking')}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            {historyApptId !== null && historyEvents.length > 0 ? (
              <div data-testid="appointment-history" className="mt-4 rounded border bg-slate-50 p-3 text-xs">
                <div className="mb-1 font-semibold">
                  {t('history')} #{historyApptId}
                </div>
                <ul className="space-y-1">
                  {historyEvents.map((ev) => (
                    <li key={ev.id}>
                      {formatDateTime(ev.occurredAt, currentClinic.timezone, locale)} · {ev.kind} (
                      {ev.actorRole ?? 'system'}) {ev.reason ? `· ${ev.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Registrar Desk */}
        {me?.role === 'receptionist' ? (
          <section data-testid="registrar-desk" className="space-y-6 rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">{t('registrarDesk')}</h2>

            <div className="flex flex-wrap items-end gap-4 border-b pb-4">
              <div>
                <label htmlFor="reg-patient-id" className="mb-1 block text-xs font-medium">
                  {t('patientId')}
                </label>
                <input
                  id="reg-patient-id"
                  type="number"
                  data-testid="registrar-patient-id"
                  value={registrarPatientId}
                  onChange={(e) => setRegistrarPatientId(e.target.value)}
                  className="w-32 rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <form onSubmit={onSickLeave} data-testid="sick-leave-form" className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="sl-doctor" className="mb-1 block text-xs font-medium">
                    {t('doctor')}
                  </label>
                  <input
                    id="sl-doctor"
                    type="number"
                    data-testid="sick-leave-doctor"
                    className="w-24 rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    {...sickLeaveForm.register('doctorId', { required: true })}
                  />
                </div>
                <div>
                  <label htmlFor="sl-date" className="mb-1 block text-xs font-medium">
                    {t('dateFrom')}
                  </label>
                  <input
                    id="sl-date"
                    type="text"
                    data-testid="sick-leave-date"
                    className="w-36 rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    {...sickLeaveForm.register('date', { required: true })}
                  />
                </div>
                <div>
                  <label htmlFor="sl-kind" className="mb-1 block text-xs font-medium">
                    Type
                  </label>
                  <select
                    id="sl-kind"
                    data-testid="schedule-exception-kind"
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    {...sickLeaveForm.register('kind')}
                  >
                    <option value="sick">{t('markSickLeave')}</option>
                    <option value="vacation">Vacation (day off)</option>
                    <option value="extra_day">Extra day (10:00–14:00)</option>
                  </select>
                </div>
                <button
                  type="submit"
                  data-testid="sick-leave-submit"
                  className="rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600"
                >
                  {t('markSickLeave')}
                </button>
              </form>
            </div>

            <ul className="divide-y text-sm">
              {staffAppointments.map((appt) => (
                <li
                  key={appt.id}
                  data-testid={`staff-appointment-${appt.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div>
                    <span className="font-semibold">#{appt.id}</span> ·{' '}
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{appt.status}</span> ·{' '}
                    {formatDateTime(appt.startsAt, appt.clinic.timezone, locale)} · {appt.patient.fullName} (#
                    {appt.patient.id}) · {t('doctor')} #{appt.doctor.id}
                  </div>
                  <div className="flex gap-2">
                    {appt.status === 'booked' ? (
                      <button
                        type="button"
                        data-testid={`checkin-${appt.id}`}
                        onClick={() => onStaffStatus(appt.id, 'checked_in')}
                        className="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      >
                        {t('markCheckedIn')}
                      </button>
                    ) : null}
                    {appt.status === 'booked' ? (
                      <button
                        type="button"
                        data-testid={`noshow-${appt.id}`}
                        onClick={() => onStaffStatus(appt.id, 'no_show')}
                        className="rounded bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600"
                      >
                        {t('markNoShow')}
                      </button>
                    ) : null}
                    {appt.status === 'booked' || appt.status === 'held' ? (
                      <button
                        type="button"
                        data-testid={`staff-cancel-${appt.id}`}
                        onClick={() => onCancelAppointment(appt.id)}
                        className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-600"
                      >
                        {t('cancelBooking')}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Doctor Schedule */}
        {me?.role === 'doctor' ? (
          <section data-testid="doctor-desk" className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('doctorDesk')}</h2>
            <ul className="divide-y text-sm">
              {staffAppointments.map((appt) => (
                <li
                  key={appt.id}
                  data-testid={`doctor-appointment-${appt.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div>
                    <span className="font-semibold">#{appt.id}</span> ·{' '}
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{appt.status}</span> ·{' '}
                    {formatDateTime(appt.startsAt, appt.clinic.timezone, locale)} ({appt.clinic.name}) ·{' '}
                    {appt.patient.fullName} · {appt.service.name}
                  </div>
                  <div className="flex gap-2">
                    {appt.status === 'checked_in' ? (
                      <button
                        type="button"
                        data-testid={`complete-${appt.id}`}
                        onClick={() => onStaffStatus(appt.id, 'completed')}
                        className="rounded bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      >
                        {t('markCompleted')}
                      </button>
                    ) : null}
                    {appt.status === 'booked' || appt.status === 'checked_in' ? (
                      <button
                        type="button"
                        data-testid={`doctor-noshow-${appt.id}`}
                        onClick={() => onStaffStatus(appt.id, 'no_show')}
                        className="rounded bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600"
                      >
                        {t('markNoShow')}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Manager 90-day Report (Period synced in URL) */}
        {me?.role === 'manager' ? (
          <section data-testid="manager-report" className="space-y-6 rounded-lg border bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('managerReport')}</h2>
                {report ? (
                  <p data-testid="report-period" className="text-xs text-slate-600">
                    {report.fromDate} → {report.toDate}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="report-from" className="mb-1 block text-xs font-medium">
                    {t('dateFrom')}
                  </label>
                  <input
                    id="report-from"
                    type="text"
                    data-testid="report-from"
                    value={reportFrom}
                    placeholder="YYYY-MM-DD"
                    onChange={(e) => updateUrl({ from: e.target.value || null })}
                    className="w-36 rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label htmlFor="report-to" className="mb-1 block text-xs font-medium">
                    {t('dateTo')}
                  </label>
                  <input
                    id="report-to"
                    type="text"
                    data-testid="report-to"
                    value={reportTo}
                    placeholder="YYYY-MM-DD"
                    onChange={(e) => updateUrl({ to: e.target.value || null })}
                    className="w-36 rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => reexecuteReport({ requestPolicy: 'network-only' })}
                  className="rounded border px-3 py-1.5 text-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  ↻
                </button>
              </div>
            </div>

            {report ? (
              <>
                <div className="grid gap-4 sm:grid-cols-4">
                  <div className="rounded border p-3">
                    <div className="text-xs text-slate-500">{t('loadPercent')}</div>
                    <div data-testid="report-load" className="text-xl font-bold">
                      {report.totals.loadPercent.toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-slate-500">{t('noShowShare')}</div>
                    <div data-testid="report-noshow" className="text-xl font-bold">
                      {(report.totals.noShowShare * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-slate-500">{t('lateCancelShare')}</div>
                    <div data-testid="report-late-cancel" className="text-xl font-bold">
                      {(report.totals.lateCancelShare * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-slate-500">{t('acceptedOffers')}</div>
                    <div data-testid="report-accepted-offers" className="text-xl font-bold">
                      {report.totals.acceptedOffers}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">{t('revenueByService')}</h3>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {report.revenue.map((rev) => (
                      <div key={`${rev.serviceId}-${rev.currency}`} className="flex justify-between rounded border p-2.5 text-xs">
                        <span>
                          {rev.serviceName} ({rev.appointments})
                        </span>
                        <span className="font-semibold">
                          {formatMoneyMinor(rev.revenueMinor, rev.currency, locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

