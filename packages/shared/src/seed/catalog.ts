/** Static seed catalog: clinics, services, and the doctor / schedule plan (docs/analysis, seed section). */
import { DateTime } from 'luxon';
import { type Rng, pick } from './rng.js';

export interface ClinicSeed {
  city: string;
  name: string;
  timezone: string;
  currency: 'UAH' | 'PLN';
  /** Multiplier applied to the base price (minor units per service minute). */
  priceFactor: number;
}

export const CLINICS: readonly ClinicSeed[] = [
  { city: 'Kyiv', name: 'Kyiv Central', timezone: 'Europe/Kyiv', currency: 'UAH', priceFactor: 1 },
  { city: 'Lviv', name: 'Lviv Clinic', timezone: 'Europe/Kyiv', currency: 'UAH', priceFactor: 0.9 },
  { city: 'Warsaw', name: 'Warsaw Clinic', timezone: 'Europe/Warsaw', currency: 'PLN', priceFactor: 0.4 },
];

export interface ServiceSeed {
  name: string;
  durationMinutes: number;
  usesUltrasoundRoom: boolean;
}

export const SERVICES: readonly ServiceSeed[] = [
  { name: 'General consultation', durationMinutes: 30, usesUltrasoundRoom: false },
  { name: 'Follow-up consultation', durationMinutes: 15, usesUltrasoundRoom: false },
  { name: 'Initial consultation', durationMinutes: 60, usesUltrasoundRoom: false },
  { name: 'Cardiology ECG', durationMinutes: 30, usesUltrasoundRoom: false },
  { name: 'Blood pressure check', durationMinutes: 15, usesUltrasoundRoom: false },
  { name: 'Physiotherapy session', durationMinutes: 45, usesUltrasoundRoom: false },
  { name: 'Massage session', durationMinutes: 60, usesUltrasoundRoom: false },
  { name: 'Dermatology review', durationMinutes: 30, usesUltrasoundRoom: false },
  { name: 'Pediatric check-up', durationMinutes: 45, usesUltrasoundRoom: false },
  { name: 'Dental cleaning', durationMinutes: 60, usesUltrasoundRoom: false },
  { name: 'Abdominal ultrasound', durationMinutes: 45, usesUltrasoundRoom: true },
  { name: 'Pelvic ultrasound', durationMinutes: 30, usesUltrasoundRoom: true },
  { name: 'Thyroid ultrasound', durationMinutes: 30, usesUltrasoundRoom: true },
  { name: 'Echocardiography', durationMinutes: 60, usesUltrasoundRoom: true },
  { name: 'Vaccination', durationMinutes: 15, usesUltrasoundRoom: false },
];

export const SPECIALTIES: readonly string[] = [
  'General practice', 'Cardiology', 'Dermatology', 'Pediatrics',
  'Physiotherapy', 'Dentistry', 'Gynecology', 'Endocrinology',
];

export const DOCTOR_COUNT = 40;
export const EXCEPTION_REASONS = ['vacation', 'sick', 'other'] as const;

export interface ShiftWindow {
  /** 'HH:MM' local start and end. */
  start: string;
  end: string;
  breakStart?: string;
  breakEnd?: string;
}

export interface DoctorSeed {
  /** 0-based index; doctor i works in clinic i % CLINICS.length. */
  index: number;
  specialty: string;
  clinicIndex: number;
  /** Indexes into SERVICES. */
  serviceIndexes: number[];
  /** Weekday (ISO 1..7) to template. */
  templates: Map<number, ShiftWindow>;
  /** Local date (YYYY-MM-DD) to exception. null means day off. */
  exceptions: Map<string, ShiftWindow | null>;
  exceptionReasons: Map<string, (typeof EXCEPTION_REASONS)[number]>;
}

const WEEKDAY_SHIFT: ShiftWindow = { start: '08:00', end: '20:00', breakStart: '13:00', breakEnd: '14:00' };
const SATURDAY_SHIFT: ShiftWindow = { start: '09:00', end: '15:00' };
const EXTRA_SUNDAY_SHIFT: ShiftWindow = { start: '10:00', end: '14:00' };
const DAY_OFF_PER_DOCTOR = 4;

/** Builds the doctor plan. `dates` is the full window of local dates (YYYY-MM-DD). */
export function buildDoctors(rng: Rng, dates: readonly string[]): DoctorSeed[] {
  const doctors: DoctorSeed[] = [];
  for (let index = 0; index < DOCTOR_COUNT; index += 1) {
    const serviceIndexes = SERVICES.map((_, i) => i).filter((i) => i < 2 || i === 4 || rng() < 0.75);
    const templates = new Map<number, ShiftWindow>();
    for (let weekday = 1; weekday <= 5; weekday += 1) templates.set(weekday, WEEKDAY_SHIFT);
    templates.set(6, SATURDAY_SHIFT);

    const exceptions = new Map<string, ShiftWindow | null>();
    const exceptionReasons = new Map<string, (typeof EXCEPTION_REASONS)[number]>();
    for (let n = 0; n < DAY_OFF_PER_DOCTOR; n += 1) {
      const date = pick(rng, dates);
      exceptions.set(date, null);
      exceptionReasons.set(date, pick(rng, EXCEPTION_REASONS));
    }
    const firstSunday = dates.find((d) => DateTime.fromISO(d).weekday === 7);
    if (index % 5 === 0 && firstSunday !== undefined) {
      exceptions.set(firstSunday, EXTRA_SUNDAY_SHIFT);
      exceptionReasons.set(firstSunday, 'other');
    }
    doctors.push({
      index,
      specialty: pick(rng, SPECIALTIES),
      clinicIndex: index % CLINICS.length,
      serviceIndexes,
      templates,
      exceptions,
      exceptionReasons,
    });
  }
  return doctors;
}

/** Shift that applies to a local date: an exception wins over the weekday template. */
export function shiftFor(doctor: DoctorSeed, date: string): ShiftWindow | null {
  if (doctor.exceptions.has(date)) return doctor.exceptions.get(date) ?? null;
  return doctor.templates.get(DateTime.fromISO(date).weekday) ?? null;
}

/** Base price in minor units for a service in a clinic (kopecks / groszy). */
export function priceMinor(clinic: ClinicSeed, service: ServiceSeed): number {
  return Math.round(service.durationMinutes * 1000 * clinic.priceFactor);
}

