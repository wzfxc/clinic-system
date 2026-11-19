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
  SearchPatientsDocument,
  SlotsChangedDocument,
  StaffAppointmentsDocument,
  UpsertScheduleExceptionDocument,
  UpsertScheduleTemplateDocument,
  type HoldSlotMutation,
} from '../graphql/generated';
import { formatDateTime, formatMoneyMinor } from '../lib/format';

type HeldAppointment = HoldSlotMutation['holdSlot'];

interface LoginFormValues {
  email: string;
  password: string;
}

interface WaitlistFormValues {
  doctorId: string;
  dateFrom: string;
  dateTo: string;
}

interface SickLeaveFormValues {
  doctorId: string;
  date: string;
  kind: 'sick' | 'vacation' | 'extra_day';
}

interface TemplateFormValues {
  doctorId: string;
  weekday: string;
  workStart: string;
  workEnd: string;
  effectiveFrom: string;
}

interface SelectedPatient {
  id: number;
  fullName: string;
  phone?: string | null;
  email?: string | null;
}

interface RescheduleTarget {
  id: number;
  timeVersion: number;
  doctorId: number;
  startsAt: string;
}

type BoardFilter = 'all' | 'waiting' | 'late' | 'with_doctor' | 'done';

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

function todayInZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

  const defaultToday = useMemo(() => todayInZone(currentClinic.timezone), [currentClinic.timezone]);
  const boardDate = searchParams.get('date') ?? defaultToday;
  const [doctorView, setDoctorView] = useState<'day' | 'week'>('day');
  const [boardFilter, setBoardFilter] = useState<BoardFilter>('all');

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

  // Staff Day Board & Doctor Day/Week Schedule query
  const staffFilter = useMemo(() => {
    if (me?.role === 'receptionist') {
      return {
        clinicId: me.clinicId ?? currentClinic.id,
        date: boardDate,
        ...(doctorIdFilter !== null ? { doctorId: doctorIdFilter } : {}),
      };
    }
    if (me?.role === 'doctor') {
      return {
        dateFrom: boardDate,
        dateTo: doctorView === 'week' ? addDaysIso(boardDate, 6) : boardDate,
      };
    }
    return undefined;
  }, [boardDate, currentClinic.id, doctorIdFilter, doctorView, me?.clinicId, me?.role]);

  const [staffApptsRes, reexecuteStaffAppts] = useQuery({
    query: StaffAppointmentsDocument,
    variables: {
      filter: staffFilter,
      first: 100,
    },
    pause: !me || (me.role !== 'receptionist' && me.role !== 'doctor'),
    requestPolicy: 'cache-and-network',
  });

  // Registrar patient search by phone / name / email (never pre-filled with Patient #1)
  const [patientSearchInput, setPatientSearchInput] = useState<string>('');
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState<string>('');
  const [selectedPatient, setSelectedPatient] = useState<SelectedPatient | null>(null);
  const [patientSearchRes] = useQuery({
    query: SearchPatientsDocument,
    variables: { query: submittedSearchQuery },
    pause: !me || me.role !== 'receptionist' || submittedSearchQuery.trim().length < 2,
    requestPolicy: 'network-only',
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

  // When slotsChanged fires over WebSocket, refetch slots, day board and waitlist offers without page reload
  const lastSlotSignal = subEvent.data?.slotsChanged;
  useEffect(() => {
    if (!lastSlotSignal) return;
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') {
      reexecuteMyWaitlist({ requestPolicy: 'network-only' });
      reexecuteMyAppts({ requestPolicy: 'network-only' });
    }
    if (me?.role === 'receptionist' || me?.role === 'doctor') {
      reexecuteStaffAppts({ requestPolicy: 'network-only' });
    }
  }, [lastSlotSignal, me?.role, reexecuteMyAppts, reexecuteMyWaitlist, reexecuteSlots, reexecuteStaffAppts]);

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
  const [, executeUpsertTemplate] = useMutation(UpsertScheduleTemplateDocument);

  // Active hold state, Reschedule picker state & 10-minute countdown timer
  const [activeHold, setActiveHold] = useState<HeldAppointment | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<RescheduleTarget | null>(null);
  const [selectedRescheduleStart, setSelectedRescheduleStart] = useState<string>('');
  const [remainingSeconds, setRemainingSeconds] = useState<number>(600);
  const [actionError, setActionError] = useState<string>('');
  const [actionMessage, setActionMessage] = useState<string>('');
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
    defaultValues: { doctorId: doctorIdParam, dateFrom: defaultToday, dateTo: addDaysIso(defaultToday, 6) },
  });

  useEffect(() => {
    waitlistForm.setValue('doctorId', doctorIdParam);
    if (doctorIdParam) waitlistForm.clearErrors('doctorId');
  }, [doctorIdParam, waitlistForm]);

  const sickLeaveForm = useForm<SickLeaveFormValues>({
    defaultValues: { doctorId: '1', date: addDaysIso(defaultToday, 1), kind: 'sick' },
  });

  const templateForm = useForm<TemplateFormValues>({
    defaultValues: { doctorId: '1', weekday: '4', workStart: '09:00', workEnd: '17:00', effectiveFrom: defaultToday },
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
    setRescheduleTarget(null);
    setSelectedPatient(null);
    setSessionMe(null);
    await executeLogout({});
    reexecuteMe({ requestPolicy: 'network-only' });
  };

  const filteredSlots = useMemo(() => {
    const all = slotsRes.data?.findFreeSlots ?? [];
    if (doctorIdFilter === null || Number.isNaN(doctorIdFilter)) return all;
    return all.filter((s) => s.doctorId === doctorIdFilter);
  }, [slotsRes.data?.findFreeSlots, doctorIdFilter]);

  const rescheduleCandidateSlots = useMemo(() => {
    if (!rescheduleTarget) return [];
    return (slotsRes.data?.findFreeSlots ?? []).filter(
      (s) => s.doctorId === rescheduleTarget.doctorId && s.startAt !== rescheduleTarget.startsAt,
    );
  }, [rescheduleTarget, slotsRes.data?.findFreeSlots]);

  useEffect(() => {
    if (rescheduleCandidateSlots.length > 0 && !selectedRescheduleStart) {
      setSelectedRescheduleStart(rescheduleCandidateSlots[0]!.startAt);
    }
  }, [rescheduleCandidateSlots, selectedRescheduleStart]);

  const onReschedule = async (appointmentId: number, expectedVersion: number, newStartsAt: string) => {
    setActionError('');
    const res = await executeReschedule({ appointmentId, expectedVersion, newStartsAt });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    setRescheduleTarget(null);
    setSelectedRescheduleStart('');
    setActionMessage(`Rescheduled #${appointmentId}`);
    reexecuteSlots({ requestPolicy: 'network-only' });
    reexecuteMyAppts({ requestPolicy: 'network-only' });
  };

  const onSlotClick = async (slot: { clinicId: number; doctorId: number; startAt: string }) => {
    setActionError('');
    setActionMessage('');

    // If patient is in Reschedule mode for this doctor, clicking a slot reschedules to that chosen slot
    if (rescheduleTarget) {
      if (slot.doctorId !== rescheduleTarget.doctorId) {
        setActionError(t('doctorRequired'));
        return;
      }
      await onReschedule(rescheduleTarget.id, rescheduleTarget.timeVersion, slot.startAt);
      return;
    }

    // Registrar MUST select a patient first (never defaults to Patient #1)
    if (me?.role === 'receptionist') {
      if (!selectedPatient) {
        setActionError(t('selectPatientFirst'));
        return;
      }
      const res = await executeHoldSlot({
        input: {
          clinicId: slot.clinicId,
          doctorId: slot.doctorId,
          serviceId,
          startsAt: slot.startAt,
          patientId: selectedPatient.id,
        },
      });
      if (res.error || !res.data?.holdSlot) {
        setActionError(extractErrorCode(res.error));
        reexecuteSlots({ requestPolicy: 'network-only' });
        return;
      }
      setActiveHold(res.data.holdSlot);
      reexecuteSlots({ requestPolicy: 'network-only' });
      reexecuteStaffAppts({ requestPolicy: 'network-only' });
      return;
    }

    const res = await executeHoldSlot({
      input: {
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
        serviceId,
        startsAt: slot.startAt,
      },
    });
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
    if (rescheduleTarget?.id === appointmentId) setRescheduleTarget(null);
    reexecuteSlots({ requestPolicy: 'network-only' });
    if (me?.role === 'patient') {
      reexecuteMyAppts({ requestPolicy: 'network-only' });
      reexecuteMyWaitlist({ requestPolicy: 'network-only' });
    }
    if (me?.role === 'receptionist') reexecuteStaffAppts({ requestPolicy: 'network-only' });
  };

  const onStartReschedule = (appt: {
    id: number;
    timeVersion: number;
    startsAt: string;
    doctor: { id: number };
    clinic: { city: string };
    service: { id: number };
  }) => {
    setActionError('');
    setRescheduleTarget({
      id: appt.id,
      timeVersion: appt.timeVersion,
      doctorId: appt.doctor.id,
      startsAt: appt.startsAt,
    });
    setSelectedRescheduleStart('');
    updateUrl({
      city: appt.clinic.city,
      serviceId: String(appt.service.id),
      doctorId: String(appt.doctor.id),
    });
  };

  const onJoinWaitlist = waitlistForm.handleSubmit(async (values) => {
    setActionError('');
    const chosenDoctor = Number(values.doctorId);
    if (!values.doctorId || !Number.isInteger(chosenDoctor) || chosenDoctor <= 0) {
      waitlistForm.setError('doctorId', { message: t('doctorRequired') });
      return;
    }
    if (values.dateFrom > values.dateTo) {
      waitlistForm.setError('dateTo', { message: t('dateRequired') });
      return;
    }
    const res = await executeJoinWaitlist({
      input: {
        clinicId: currentClinic.id,
        doctorId: chosenDoctor,
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

  const onUpsertTemplate = templateForm.handleSubmit(async (values) => {
    setActionError('');
    const clinicId = me?.clinicId ?? currentClinic.id;
    const res = await executeUpsertTemplate({
      input: {
        doctorId: Number(values.doctorId),
        clinicId,
        weekday: Number(values.weekday),
        workStart: values.workStart,
        workEnd: values.workEnd,
        effectiveFrom: values.effectiveFrom || null,
      },
    });
    if (res.error) {
      setActionError(extractErrorCode(res.error));
      return;
    }
    setActionMessage(`Template updated: doctor #${values.doctorId} weekday ${values.weekday}`);
    reexecuteSlots({ requestPolicy: 'network-only' });
  });

  const nowMs = Date.now();
  const myAppointments = myApptsRes.data?.myAppointments ?? [];
  const activeAppointmentsCount = myAppointments.filter((a) => a.status !== 'cancelled').length;
  const upcomingMyAppointments = myAppointments.filter(
    (a) => (a.status === 'booked' || a.status === 'held' || a.status === 'checked_in') && new Date(a.startsAt).getTime() >= nowMs,
  );
  const pastMyAppointments = myAppointments.filter(
    (a) => !upcomingMyAppointments.some((u) => u.id === a.id),
  );
  const pendingOffers = (myWaitlistRes.data?.myWaitlistOffers ?? []).filter((o) => o.status === 'pending');
  const waitlistEntries = myWaitlistRes.data?.myWaitlistEntries ?? [];
  const myReminders = myRemindersRes.data?.myReminders ?? [];
  const historyEvents = historyRes.data?.appointmentHistory ?? [];
  const staffAppointments = useMemo(() => staffApptsRes.data?.appointments ?? [], [staffApptsRes.data?.appointments]);
  const searchedPatients = patientSearchRes.data?.searchPatients ?? [];
  const report = reportRes.data?.managerReport;
  void reexecuteMyReminders;

  const isLateVisit = useCallback(
    (appt: { status: string; startsAt: string }) =>
      appt.status === 'booked' && new Date(appt.startsAt).getTime() < Date.now(),
    [],
  );

  const boardCounts = useMemo(() => {
    let waiting = 0;
    let late = 0;
    let withDoctor = 0;
    let done = 0;
    for (const a of staffAppointments) {
      if (a.status === 'checked_in') withDoctor += 1;
      else if (a.status === 'booked') {
        if (isLateVisit(a)) late += 1;
        else waiting += 1;
      } else {
        done += 1;
      }
    }
    return { all: staffAppointments.length, waiting, late, withDoctor, done };
  }, [isLateVisit, staffAppointments]);

  const filteredBoardAppointments = useMemo(() => {
    return staffAppointments.filter((a) => {
      switch (boardFilter) {
        case 'waiting':
          return a.status === 'booked' && !isLateVisit(a);
        case 'late':
          return isLateVisit(a);
        case 'with_doctor':
          return a.status === 'checked_in';
        case 'done':
          return a.status === 'completed' || a.status === 'no_show' || a.status === 'cancelled';
        default:
          return true;
      }
    });
  }, [boardFilter, isLateVisit, staffAppointments]);

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
        {/* Locale & formatting summary bar */}
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

          {/* Reschedule time picker banner (lets the patient choose any free slot of that doctor) */}
          {rescheduleTarget ? (
            <div
              data-testid="reschedule-banner"
              className="mt-6 rounded-lg border-2 border-blue-500 bg-blue-50 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-blue-900">
                    {t('selectTimeToReschedule')} #{rescheduleTarget.id} ({t('doctor')} #{rescheduleTarget.doctorId})
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="reschedule-slot-select"
                    value={selectedRescheduleStart}
                    onChange={(e) => setSelectedRescheduleStart(e.target.value)}
                    className="rounded border border-blue-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {rescheduleCandidateSlots.map((s) => (
                      <option key={s.startAt} value={s.startAt}>
                        {s.localDate} {s.localTime}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="confirm-reschedule-btn"
                    disabled={!selectedRescheduleStart}
                    onClick={() =>
                      selectedRescheduleStart &&
                      onReschedule(rescheduleTarget.id, rescheduleTarget.timeVersion, selectedRescheduleStart)
                    }
                    className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {t('confirmReschedule')}
                  </button>
                  <button
                    type="button"
                    data-testid="cancel-reschedule-btn"
                    onClick={() => setRescheduleTarget(null)}
                    className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {t('cancelBooking')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

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
                      onClick={() => onSlotClick(slot)}
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

        {/* Patient Waitlist & Offers (Requires explicit doctor choice — never defaults silently to Doctor #1) */}
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
                        #{offer.id} · {t('doctor')} #{offer.doctorId}
                      </p>
                      <p className="text-sm text-emerald-800">
                        {formatDateTime(offer.startsAt, currentClinic.timezone, locale)} →{' '}
                        {formatDateTime(offer.expiresAt, currentClinic.timezone, locale)}
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
              className="flex flex-wrap items-start gap-4"
            >
              <div>
                <label htmlFor="wl-doctor" className="mb-1 block text-xs font-medium">
                  {t('doctor')}
                </label>
                <select
                  id="wl-doctor"
                  data-testid="waitlist-doctor"
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  {...waitlistForm.register('doctorId', {
                    required: t('doctorRequired'),
                  })}
                >
                  <option value="">{t('selectDoctorPrompt')}</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      #{d.id} — {d.specialty}
                    </option>
                  ))}
                </select>
                {waitlistForm.formState.errors.doctorId ? (
                  <p role="alert" data-testid="waitlist-doctor-error" className="mt-1 text-xs text-red-600">
                    {waitlistForm.formState.errors.doctorId.message}
                  </p>
                ) : null}
              </div>

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

              <div className="pt-5">
                <button
                  type="submit"
                  data-testid="join-waitlist-btn"
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {t('joinWaitlist')}
                </button>
              </div>
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

        {/* Patient Appointments (Upcoming & Past) */}
        {me?.role === 'patient' ? (
          <section data-testid="my-appointments" className="space-y-4 rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">
              {t('myAppointments')} ({tHome('appointments', { count: activeAppointmentsCount })})
            </h2>

            {([
              { label: t('upcomingVisits'), list: upcomingMyAppointments },
              { label: t('pastVisits'), list: pastMyAppointments },
            ] as const).map((group) =>
              group.list.length > 0 ? (
                <div key={group.label}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.label}</h3>
                  <ul className="divide-y text-sm">
                    {group.list.map((appt) => (
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
                          {appt.status === 'booked' ? (
                            <button
                              type="button"
                              data-testid={`reschedule-appointment-${appt.id}`}
                              onClick={() => onStartReschedule(appt)}
                              className="rounded border border-blue-300 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-600"
                            >
                              {t('reschedule')}
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
                    ))}
                  </ul>
                </div>
              ) : null,
            )}

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

        {/* Registrar Desk: Patient Phone Search + Day Board (expected / late / with doctor / done) + Schedule Exceptions & Weekly Templates */}
        {me?.role === 'receptionist' ? (
          <section data-testid="registrar-desk" className="space-y-6 rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">{t('registrarDesk')}</h2>

            {/* Phone / Name / Email Patient Lookup for Front-Desk Booking */}
            <div className="space-y-3 rounded-lg border bg-slate-50 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[260px] flex-1">
                  <label htmlFor="reg-patient-search" className="mb-1 block text-xs font-medium">
                    {t('searchPatient')}
                  </label>
                  <input
                    id="reg-patient-search"
                    type="text"
                    data-testid="registrar-patient-search"
                    value={patientSearchInput}
                    placeholder={t('searchPatientPlaceholder')}
                    onChange={(e) => setPatientSearchInput(e.target.value)}
                    className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <button
                  type="button"
                  data-testid="registrar-search-btn"
                  onClick={() => setSubmittedSearchQuery(patientSearchInput.trim())}
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {t('searchPatient')}
                </button>
              </div>

              {selectedPatient ? (
                <div
                  data-testid="selected-patient-banner"
                  className="flex items-center justify-between rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900"
                >
                  <span>
                    {t('selectedPatient')}: #{selectedPatient.id} · {selectedPatient.fullName} ·{' '}
                    {selectedPatient.phone ?? '—'} · {selectedPatient.email ?? '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedPatient(null)}
                    className="rounded border bg-white px-2 py-0.5 text-xs hover:bg-slate-100"
                  >
                    ✕
                  </button>
                </div>
              ) : null}

              {searchedPatients.length > 0 ? (
                <ul data-testid="patient-search-results" className="divide-y rounded border bg-white text-xs">
                  {searchedPatients.map((p) => (
                    <li key={p.id} className="flex items-center justify-between px-3 py-2">
                      <span>
                        #{p.id} · <span className="font-semibold">{p.fullName}</span> · {p.phone ?? '—'} ·{' '}
                        {p.email ?? '—'}
                      </span>
                      <button
                        type="button"
                        data-testid={`select-patient-${p.id}`}
                        onClick={() => setSelectedPatient(p)}
                        className="rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700"
                      >
                        {t('book')}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Schedule Management: Date Exceptions (Sick Leave, Vacation, Extra Day) & Weekly Templates */}
            <div className="grid gap-4 border-b pb-4 md:grid-cols-2">
              <form onSubmit={onSickLeave} data-testid="sick-leave-form" className="flex flex-wrap items-end gap-3 rounded border p-3">
                <div>
                  <label htmlFor="sl-doctor" className="mb-1 block text-xs font-medium">
                    {t('doctor')}
                  </label>
                  <input
                    id="sl-doctor"
                    type="number"
                    data-testid="sick-leave-doctor"
                    className="w-20 rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
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
                    className="w-32 rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
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
                    className="rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
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

              <form onSubmit={onUpsertTemplate} data-testid="template-form" className="flex flex-wrap items-end gap-2 rounded border p-3">
                <div>
                  <label htmlFor="tpl-doctor" className="mb-1 block text-xs font-medium">
                    {t('doctor')}
                  </label>
                  <input
                    id="tpl-doctor"
                    type="number"
                    data-testid="template-doctor"
                    className="w-16 rounded border border-slate-300 px-2 py-1.5 text-sm"
                    {...templateForm.register('doctorId', { required: true })}
                  />
                </div>
                <div>
                  <label htmlFor="tpl-weekday" className="mb-1 block text-xs font-medium">
                    Day (1-7)
                  </label>
                  <input
                    id="tpl-weekday"
                    type="number"
                    min={1}
                    max={7}
                    data-testid="template-weekday"
                    className="w-16 rounded border border-slate-300 px-2 py-1.5 text-sm"
                    {...templateForm.register('weekday', { required: true })}
                  />
                </div>
                <div>
                  <label htmlFor="tpl-start" className="mb-1 block text-xs font-medium">
                    Start
                  </label>
                  <input
                    id="tpl-start"
                    type="text"
                    data-testid="template-start"
                    className="w-20 rounded border border-slate-300 px-2 py-1.5 text-sm"
                    {...templateForm.register('workStart', { required: true })}
                  />
                </div>
                <div>
                  <label htmlFor="tpl-end" className="mb-1 block text-xs font-medium">
                    End
                  </label>
                  <input
                    id="tpl-end"
                    type="text"
                    data-testid="template-end"
                    className="w-20 rounded border border-slate-300 px-2 py-1.5 text-sm"
                    {...templateForm.register('workEnd', { required: true })}
                  />
                </div>
                <button
                  type="submit"
                  data-testid="template-submit"
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-900"
                >
                  {t('weeklyTemplate')}
                </button>
              </form>
            </div>

            {/* Registrar Day Board */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold">{t('dayBoard')}</h3>
                  <input
                    type="date"
                    data-testid="board-date"
                    value={boardDate}
                    onChange={(e) => updateUrl({ date: e.target.value || null })}
                    className="rounded border border-slate-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <div className="flex flex-wrap gap-2 text-xs font-medium">
                  {(
                    [
                      ['all', `${t('boardAll')} (${boardCounts.all})`],
                      ['waiting', `${t('boardWaiting')} (${boardCounts.waiting})`],
                      ['late', `${t('boardLate')} (${boardCounts.late})`],
                      ['with_doctor', `${t('boardWithDoctor')} (${boardCounts.withDoctor})`],
                      ['done', `${t('boardDone')} (${boardCounts.done})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      data-testid={`board-filter-${key}`}
                      onClick={() => setBoardFilter(key)}
                      className={`rounded-full px-3 py-1 ${
                        boardFilter === key
                          ? 'bg-blue-600 text-white'
                          : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <ul data-testid="day-board-list" className="divide-y text-sm">
                {filteredBoardAppointments.map((appt) => {
                  const late = isLateVisit(appt);
                  return (
                    <li
                      key={appt.id}
                      data-testid={`staff-appointment-${appt.id}`}
                      data-status={appt.status}
                      className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                    >
                      <div>
                        <span className="font-semibold">#{appt.id}</span> ·{' '}
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            appt.status === 'checked_in'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-800'
                          }`}
                        >
                          {statusLabel(appt.status)}
                        </span>{' '}
                        {late ? (
                          <span
                            data-testid={`late-badge-${appt.id}`}
                            className="ml-1 rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700"
                          >
                            {t('lateBadge')}
                          </span>
                        ) : null}{' '}
                        · {formatDateTime(appt.startsAt, appt.clinic.timezone, locale)} · {appt.patient.fullName} (#
                        {appt.patient.id} · {appt.patient.phone ?? '—'}) · {t('doctor')} #{appt.doctor.id}
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
                  );
                })}
              </ul>
            </div>
          </section>
        ) : null}

        {/* Doctor Schedule: Day and Week View across all clinics where the doctor works */}
        {me?.role === 'doctor' ? (
          <section data-testid="doctor-desk" className="space-y-4 rounded-lg border bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{t('doctorDesk')}</h2>
                <input
                  type="date"
                  data-testid="doctor-board-date"
                  value={boardDate}
                  onChange={(e) => updateUrl({ date: e.target.value || null })}
                  className="rounded border border-slate-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div className="flex gap-2 text-xs font-medium">
                <button
                  type="button"
                  data-testid="doctor-view-day"
                  onClick={() => setDoctorView('day')}
                  className={`rounded px-3 py-1 ${
                    doctorView === 'day' ? 'bg-blue-600 text-white' : 'border bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {t('dayView')} ({boardDate})
                </button>
                <button
                  type="button"
                  data-testid="doctor-view-week"
                  onClick={() => setDoctorView('week')}
                  className={`rounded px-3 py-1 ${
                    doctorView === 'week' ? 'bg-blue-600 text-white' : 'border bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {t('weekView')} ({boardDate} → {addDaysIso(boardDate, 6)})
                </button>
              </div>
            </div>

            <ul className="divide-y text-sm">
              {staffAppointments.map((appt) => {
                const late = isLateVisit(appt);
                return (
                  <li
                    key={appt.id}
                    data-testid={`doctor-appointment-${appt.id}`}
                    data-status={appt.status}
                    className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                  >
                    <div>
                      <span className="font-semibold">#{appt.id}</span> ·{' '}
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{statusLabel(appt.status)}</span>
                      {late ? (
                        <span className="ml-1 rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                          {t('lateBadge')}
                        </span>
                      ) : null}{' '}
                      · <span className="font-medium">{appt.localDate}</span> ·{' '}
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
                );
              })}
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
