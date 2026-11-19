import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: string; output: string; }
};

export type Appointment = {
  __typename?: 'Appointment';
  clinic: Clinic;
  currency: Scalars['String']['output'];
  doctor: Doctor;
  endsAt: Scalars['DateTime']['output'];
  holdExpiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['Int']['output'];
  localDate: Scalars['String']['output'];
  patient: Patient;
  priceMinor: Scalars['Int']['output'];
  service: Service;
  startsAt: Scalars['DateTime']['output'];
  status: Scalars['String']['output'];
  timeVersion: Scalars['Int']['output'];
};

export type AppointmentEvent = {
  __typename?: 'AppointmentEvent';
  actorRole?: Maybe<Scalars['String']['output']>;
  appointmentId: Scalars['Int']['output'];
  fromStatus?: Maybe<Scalars['String']['output']>;
  id: Scalars['Int']['output'];
  isLate: Scalars['Boolean']['output'];
  isStrike: Scalars['Boolean']['output'];
  kind: Scalars['String']['output'];
  occurredAt: Scalars['DateTime']['output'];
  reason?: Maybe<Scalars['String']['output']>;
  toStatus?: Maybe<Scalars['String']['output']>;
};

export type AppointmentFilter = {
  clinicId?: InputMaybe<Scalars['Int']['input']>;
  date?: InputMaybe<Scalars['String']['input']>;
  dateFrom?: InputMaybe<Scalars['String']['input']>;
  dateTo?: InputMaybe<Scalars['String']['input']>;
  doctorId?: InputMaybe<Scalars['Int']['input']>;
  patientId?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type CityFreeSlot = {
  __typename?: 'CityFreeSlot';
  clinicId: Scalars['Int']['output'];
  doctorId: Scalars['Int']['output'];
  endAt: Scalars['DateTime']['output'];
  localDate: Scalars['String']['output'];
  localTime: Scalars['String']['output'];
  startAt: Scalars['DateTime']['output'];
  utcOffsetMinutes: Scalars['Int']['output'];
};

export type Clinic = {
  __typename?: 'Clinic';
  city: Scalars['String']['output'];
  currency: Scalars['String']['output'];
  id: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  timezone: Scalars['String']['output'];
};

export type Doctor = {
  __typename?: 'Doctor';
  id: Scalars['Int']['output'];
  specialty: Scalars['String']['output'];
};

export type DoctorReport = {
  __typename?: 'DoctorReport';
  acceptedOffers: Scalars['Int']['output'];
  bookedMinutes: Scalars['Int']['output'];
  /** User-side cancellations (system reasons excluded). */
  cancelled: Scalars['Int']['output'];
  clinicId: Scalars['Int']['output'];
  completed: Scalars['Int']['output'];
  doctorId: Scalars['Int']['output'];
  /** Late cancellations (24 h or less before start) over cancellations, 0 to 1. */
  lateCancelShare: Scalars['Float']['output'];
  lateCancelled: Scalars['Int']['output'];
  /** Booked minutes over scheduled minutes, 0 to 100. */
  loadPercent: Scalars['Float']['output'];
  noShow: Scalars['Int']['output'];
  /** no_show / (completed + no_show), 0 to 1. */
  noShowShare: Scalars['Float']['output'];
  scheduledMinutes: Scalars['Int']['output'];
};

export type HoldSlotInput = {
  clinicId: Scalars['Int']['input'];
  doctorId: Scalars['Int']['input'];
  patientId?: InputMaybe<Scalars['Int']['input']>;
  serviceId: Scalars['Int']['input'];
  startsAt: Scalars['DateTime']['input'];
};

export type InAppReminder = {
  __typename?: 'InAppReminder';
  appointmentId: Scalars['Int']['output'];
  clinicId: Scalars['Int']['output'];
  doctorId: Scalars['Int']['output'];
  dueAt: Scalars['DateTime']['output'];
  id: Scalars['Int']['output'];
  kind: Scalars['String']['output'];
  startsAt: Scalars['DateTime']['output'];
};

export type JoinWaitlistInput = {
  clinicId: Scalars['Int']['input'];
  dateFrom: Scalars['String']['input'];
  dateTo: Scalars['String']['input'];
  doctorId: Scalars['Int']['input'];
  serviceId: Scalars['Int']['input'];
};

export type Me = {
  __typename?: 'Me';
  clinicId?: Maybe<Scalars['Int']['output']>;
  doctorId?: Maybe<Scalars['Int']['output']>;
  patientId?: Maybe<Scalars['Int']['output']>;
  role: Scalars['String']['output'];
  userId: Scalars['Int']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  acceptOffer: Appointment;
  /** Cancels a booked or held visit. Patient: own; registrar: own clinic. */
  cancelAppointment: Appointment;
  /** Registrar or doctor moves a visit to checked_in, no_show or completed. */
  changeAppointmentStatus: Appointment;
  confirmAppointment: Appointment;
  declineOffer: Scalars['Boolean']['output'];
  /** Places a 10-minute checkout hold for the signed-in patient. */
  holdSlot: Appointment;
  /** Joins the waitlist; returns the entry id. */
  joinWaitlist: Scalars['Int']['output'];
  leaveWaitlist: Scalars['Boolean']['output'];
  login: Me;
  logout: Scalars['Boolean']['output'];
  /** Registrar marks a doctor sick for a clinic day. */
  markSickLeave: SickLeavePayload;
  register: Me;
  rescheduleAppointment: Appointment;
  /** Registrar sets a date exception (vacation, sick, extra_day) for a doctor. */
  upsertScheduleException: Scalars['Boolean']['output'];
  /** Registrar updates a doctor weekly schedule template in their clinic. */
  upsertScheduleTemplate: Scalars['Boolean']['output'];
};


export type MutationAcceptOfferArgs = {
  idempotencyKey: Scalars['String']['input'];
  offerId: Scalars['Int']['input'];
};


export type MutationCancelAppointmentArgs = {
  appointmentId: Scalars['Int']['input'];
  reason: Scalars['String']['input'];
};


export type MutationChangeAppointmentStatusArgs = {
  appointmentId: Scalars['Int']['input'];
  to: Scalars['String']['input'];
};


export type MutationConfirmAppointmentArgs = {
  appointmentId: Scalars['Int']['input'];
  idempotencyKey: Scalars['String']['input'];
};


export type MutationDeclineOfferArgs = {
  offerId: Scalars['Int']['input'];
};


export type MutationHoldSlotArgs = {
  input: HoldSlotInput;
};


export type MutationJoinWaitlistArgs = {
  input: JoinWaitlistInput;
};


export type MutationLeaveWaitlistArgs = {
  entryId: Scalars['Int']['input'];
};


export type MutationLoginArgs = {
  email: Scalars['String']['input'];
  password: Scalars['String']['input'];
};


export type MutationMarkSickLeaveArgs = {
  clinicId: Scalars['Int']['input'];
  date: Scalars['String']['input'];
  doctorId: Scalars['Int']['input'];
};


export type MutationRegisterArgs = {
  input: RegisterInput;
};


export type MutationRescheduleAppointmentArgs = {
  appointmentId: Scalars['Int']['input'];
  expectedVersion: Scalars['Int']['input'];
  newStartsAt: Scalars['DateTime']['input'];
};


export type MutationUpsertScheduleExceptionArgs = {
  input: UpsertScheduleExceptionInput;
};


export type MutationUpsertScheduleTemplateArgs = {
  input: UpsertScheduleTemplateInput;
};

export type Patient = {
  __typename?: 'Patient';
  email?: Maybe<Scalars['String']['output']>;
  fullName: Scalars['String']['output'];
  id: Scalars['Int']['output'];
  phone?: Maybe<Scalars['String']['output']>;
};

export type Query = {
  __typename?: 'Query';
  appointment?: Maybe<Appointment>;
  /** Audit history of a visible appointment. */
  appointmentHistory: Array<AppointmentEvent>;
  /** Appointments visible to the actor, filtered within that scope. */
  appointments: Array<Appointment>;
  /** All clinics in the network. */
  clinics: Array<Clinic>;
  /** Doctors, optionally filtered by clinic. */
  doctors: Array<Doctor>;
  /** Free slots of a service across the doctors of a city for the next 14 days (clinic-local grid, R2 visibility). */
  findFreeSlots: Array<CityFreeSlot>;
  /** Manager report over the 90 complete days before today (Clock, UTC date). */
  managerReport: Report;
  /** The signed-in account. */
  me: Me;
  /** The signed-in patient's own appointments (newest first). */
  myAppointments: Array<Appointment>;
  /** In-app 24h and 2h visit reminders for the signed-in patient. */
  myReminders: Array<InAppReminder>;
  /** Active waitlist entries for the signed-in patient. */
  myWaitlistEntries: Array<WaitlistEntry>;
  /** Pending and recent waitlist offers for the signed-in patient. */
  myWaitlistOffers: Array<WaitlistOffer>;
  /** Registrar searches patients by phone, name or email. */
  searchPatients: Array<Patient>;
  /** All services offered across the network. */
  services: Array<Service>;
};


export type QueryAppointmentArgs = {
  id: Scalars['Int']['input'];
};


export type QueryAppointmentHistoryArgs = {
  appointmentId: Scalars['Int']['input'];
};


export type QueryAppointmentsArgs = {
  filter?: InputMaybe<AppointmentFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryDoctorsArgs = {
  clinicId?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryFindFreeSlotsArgs = {
  city: Scalars['String']['input'];
  serviceId: Scalars['Int']['input'];
};


export type QueryManagerReportArgs = {
  fromDate?: InputMaybe<Scalars['String']['input']>;
  toDate?: InputMaybe<Scalars['String']['input']>;
};


export type QueryMyAppointmentsArgs = {
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySearchPatientsArgs = {
  query: Scalars['String']['input'];
};

export type RegisterInput = {
  email: Scalars['String']['input'];
  fullName: Scalars['String']['input'];
  password: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
};

export type Report = {
  __typename?: 'Report';
  doctors: Array<DoctorReport>;
  fromDate: Scalars['String']['output'];
  revenue: Array<ServiceRevenue>;
  toDate: Scalars['String']['output'];
  totals: ReportMetrics;
};

export type ReportMetrics = {
  __typename?: 'ReportMetrics';
  acceptedOffers: Scalars['Int']['output'];
  bookedMinutes: Scalars['Int']['output'];
  /** User-side cancellations (system reasons excluded). */
  cancelled: Scalars['Int']['output'];
  completed: Scalars['Int']['output'];
  /** Late cancellations (24 h or less before start) over cancellations, 0 to 1. */
  lateCancelShare: Scalars['Float']['output'];
  lateCancelled: Scalars['Int']['output'];
  /** Booked minutes over scheduled minutes, 0 to 100. */
  loadPercent: Scalars['Float']['output'];
  noShow: Scalars['Int']['output'];
  /** no_show / (completed + no_show), 0 to 1. */
  noShowShare: Scalars['Float']['output'];
  scheduledMinutes: Scalars['Int']['output'];
};

export type Service = {
  __typename?: 'Service';
  durationMinutes: Scalars['Int']['output'];
  id: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  usesUltrasoundRoom: Scalars['Boolean']['output'];
};

export type ServiceRevenue = {
  __typename?: 'ServiceRevenue';
  appointments: Scalars['Int']['output'];
  currency: Scalars['String']['output'];
  /** Minor currency units (kopecks, groszy) of completed appointments. */
  revenueMinor: Scalars['Float']['output'];
  serviceId: Scalars['Int']['output'];
  serviceName: Scalars['String']['output'];
};

export type SickLeavePayload = {
  __typename?: 'SickLeavePayload';
  applied: Scalars['Boolean']['output'];
  cancelledAppointmentIds: Array<Scalars['Int']['output']>;
};

export type SlotsChanged = {
  __typename?: 'SlotsChanged';
  clinicId: Scalars['Int']['output'];
  doctorId: Scalars['Int']['output'];
  startsAt: Scalars['DateTime']['output'];
};

export type Subscription = {
  __typename?: 'Subscription';
  /** Free-slot changes of a clinic. Carries no patient or appointment ids; refetch the slot grid. */
  slotsChanged: SlotsChanged;
};


export type SubscriptionSlotsChangedArgs = {
  clinicId: Scalars['Int']['input'];
};

export type UpsertScheduleExceptionInput = {
  breakEnd?: InputMaybe<Scalars['String']['input']>;
  breakStart?: InputMaybe<Scalars['String']['input']>;
  clinicId: Scalars['Int']['input'];
  date: Scalars['String']['input'];
  doctorId: Scalars['Int']['input'];
  kind: Scalars['String']['input'];
  reason: Scalars['String']['input'];
  workEnd?: InputMaybe<Scalars['String']['input']>;
  workStart?: InputMaybe<Scalars['String']['input']>;
};

export type UpsertScheduleTemplateInput = {
  breakEnd?: InputMaybe<Scalars['String']['input']>;
  breakStart?: InputMaybe<Scalars['String']['input']>;
  clinicId: Scalars['Int']['input'];
  doctorId: Scalars['Int']['input'];
  effectiveFrom?: InputMaybe<Scalars['String']['input']>;
  weekday: Scalars['Int']['input'];
  workEnd: Scalars['String']['input'];
  workStart: Scalars['String']['input'];
};

export type WaitlistEntry = {
  __typename?: 'WaitlistEntry';
  clinicId: Scalars['Int']['output'];
  dateFrom: Scalars['String']['output'];
  dateTo: Scalars['String']['output'];
  doctorId: Scalars['Int']['output'];
  id: Scalars['Int']['output'];
  priority: Scalars['Int']['output'];
  serviceId: Scalars['Int']['output'];
  status: Scalars['String']['output'];
};

export type WaitlistOffer = {
  __typename?: 'WaitlistOffer';
  appointmentId: Scalars['Int']['output'];
  clinicId: Scalars['Int']['output'];
  doctorId: Scalars['Int']['output'];
  endsAt: Scalars['DateTime']['output'];
  entryId: Scalars['Int']['output'];
  expiresAt: Scalars['DateTime']['output'];
  id: Scalars['Int']['output'];
  serviceId: Scalars['Int']['output'];
  startsAt: Scalars['DateTime']['output'];
  status: Scalars['String']['output'];
};

export type CatalogQueryVariables = Exact<{ [key: string]: never; }>;


export type CatalogQuery = { __typename?: 'Query', clinics: Array<{ __typename?: 'Clinic', id: number, city: string, name: string, timezone: string, currency: string }>, services: Array<{ __typename?: 'Service', id: number, name: string, durationMinutes: number, usesUltrasoundRoom: boolean }>, doctors: Array<{ __typename?: 'Doctor', id: number, specialty: string }> };

export type MeQueryVariables = Exact<{ [key: string]: never; }>;


export type MeQuery = { __typename?: 'Query', me: { __typename?: 'Me', userId: number, role: string, clinicId?: number | null, patientId?: number | null, doctorId?: number | null } };

export type LoginMutationVariables = Exact<{
  email: Scalars['String']['input'];
  password: Scalars['String']['input'];
}>;


export type LoginMutation = { __typename?: 'Mutation', login: { __typename?: 'Me', userId: number, role: string, clinicId?: number | null, patientId?: number | null, doctorId?: number | null } };

export type RegisterMutationVariables = Exact<{
  input: RegisterInput;
}>;


export type RegisterMutation = { __typename?: 'Mutation', register: { __typename?: 'Me', userId: number, role: string, clinicId?: number | null, patientId?: number | null, doctorId?: number | null } };

export type LogoutMutationVariables = Exact<{ [key: string]: never; }>;


export type LogoutMutation = { __typename?: 'Mutation', logout: boolean };

export type FindFreeSlotsQueryVariables = Exact<{
  city: Scalars['String']['input'];
  serviceId: Scalars['Int']['input'];
}>;


export type FindFreeSlotsQuery = { __typename?: 'Query', findFreeSlots: Array<{ __typename?: 'CityFreeSlot', clinicId: number, doctorId: number, startAt: string, endAt: string, localDate: string, localTime: string, utcOffsetMinutes: number }> };

export type SlotsChangedSubscriptionVariables = Exact<{
  clinicId: Scalars['Int']['input'];
}>;


export type SlotsChangedSubscription = { __typename?: 'Subscription', slotsChanged: { __typename?: 'SlotsChanged', clinicId: number, doctorId: number, startsAt: string } };

export type HoldSlotMutationVariables = Exact<{
  input: HoldSlotInput;
}>;


export type HoldSlotMutation = { __typename?: 'Mutation', holdSlot: { __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string, priceMinor: number, currency: string, timeVersion: number, holdExpiresAt?: string | null } };

export type ConfirmAppointmentMutationVariables = Exact<{
  appointmentId: Scalars['Int']['input'];
  idempotencyKey: Scalars['String']['input'];
}>;


export type ConfirmAppointmentMutation = { __typename?: 'Mutation', confirmAppointment: { __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string, priceMinor: number, currency: string, timeVersion: number } };

export type CancelAppointmentMutationVariables = Exact<{
  appointmentId: Scalars['Int']['input'];
  reason: Scalars['String']['input'];
}>;


export type CancelAppointmentMutation = { __typename?: 'Mutation', cancelAppointment: { __typename?: 'Appointment', id: number, status: string } };

export type RescheduleAppointmentMutationVariables = Exact<{
  appointmentId: Scalars['Int']['input'];
  expectedVersion: Scalars['Int']['input'];
  newStartsAt: Scalars['DateTime']['input'];
}>;


export type RescheduleAppointmentMutation = { __typename?: 'Mutation', rescheduleAppointment: { __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string, timeVersion: number } };

export type MyAppointmentsQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type MyAppointmentsQuery = { __typename?: 'Query', myAppointments: Array<{ __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string, priceMinor: number, currency: string, timeVersion: number, holdExpiresAt?: string | null, doctor: { __typename?: 'Doctor', id: number, specialty: string }, clinic: { __typename?: 'Clinic', id: number, city: string, name: string, timezone: string, currency: string }, service: { __typename?: 'Service', id: number, name: string, durationMinutes: number } }> };

export type StaffAppointmentsQueryVariables = Exact<{
  filter?: InputMaybe<AppointmentFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type StaffAppointmentsQuery = { __typename?: 'Query', appointments: Array<{ __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string, priceMinor: number, currency: string, timeVersion: number, doctor: { __typename?: 'Doctor', id: number, specialty: string }, clinic: { __typename?: 'Clinic', id: number, city: string, name: string, timezone: string, currency: string }, service: { __typename?: 'Service', id: number, name: string, durationMinutes: number }, patient: { __typename?: 'Patient', id: number, fullName: string, email?: string | null, phone?: string | null } }> };

export type SearchPatientsQueryVariables = Exact<{
  query: Scalars['String']['input'];
}>;


export type SearchPatientsQuery = { __typename?: 'Query', searchPatients: Array<{ __typename?: 'Patient', id: number, fullName: string, phone?: string | null, email?: string | null }> };

export type ChangeAppointmentStatusMutationVariables = Exact<{
  appointmentId: Scalars['Int']['input'];
  to: Scalars['String']['input'];
}>;


export type ChangeAppointmentStatusMutation = { __typename?: 'Mutation', changeAppointmentStatus: { __typename?: 'Appointment', id: number, status: string } };

export type MarkSickLeaveMutationVariables = Exact<{
  doctorId: Scalars['Int']['input'];
  clinicId: Scalars['Int']['input'];
  date: Scalars['String']['input'];
}>;


export type MarkSickLeaveMutation = { __typename?: 'Mutation', markSickLeave: { __typename?: 'SickLeavePayload', applied: boolean, cancelledAppointmentIds: Array<number> } };

export type MyWaitlistQueryVariables = Exact<{ [key: string]: never; }>;


export type MyWaitlistQuery = { __typename?: 'Query', myWaitlistOffers: Array<{ __typename?: 'WaitlistOffer', id: number, entryId: number, appointmentId: number, clinicId: number, doctorId: number, serviceId: number, startsAt: string, endsAt: string, expiresAt: string, status: string }>, myWaitlistEntries: Array<{ __typename?: 'WaitlistEntry', id: number, clinicId: number, doctorId: number, serviceId: number, dateFrom: string, dateTo: string, priority: number, status: string }> };

export type JoinWaitlistMutationVariables = Exact<{
  input: JoinWaitlistInput;
}>;


export type JoinWaitlistMutation = { __typename?: 'Mutation', joinWaitlist: number };

export type LeaveWaitlistMutationVariables = Exact<{
  entryId: Scalars['Int']['input'];
}>;


export type LeaveWaitlistMutation = { __typename?: 'Mutation', leaveWaitlist: boolean };

export type AcceptOfferMutationVariables = Exact<{
  offerId: Scalars['Int']['input'];
  idempotencyKey: Scalars['String']['input'];
}>;


export type AcceptOfferMutation = { __typename?: 'Mutation', acceptOffer: { __typename?: 'Appointment', id: number, status: string, startsAt: string, endsAt: string, localDate: string } };

export type DeclineOfferMutationVariables = Exact<{
  offerId: Scalars['Int']['input'];
}>;


export type DeclineOfferMutation = { __typename?: 'Mutation', declineOffer: boolean };

export type MyRemindersQueryVariables = Exact<{ [key: string]: never; }>;


export type MyRemindersQuery = { __typename?: 'Query', myReminders: Array<{ __typename?: 'InAppReminder', id: number, appointmentId: number, kind: string, dueAt: string, startsAt: string, clinicId: number, doctorId: number }> };

export type AppointmentHistoryQueryVariables = Exact<{
  appointmentId: Scalars['Int']['input'];
}>;


export type AppointmentHistoryQuery = { __typename?: 'Query', appointmentHistory: Array<{ __typename?: 'AppointmentEvent', id: number, appointmentId: number, kind: string, fromStatus?: string | null, toStatus?: string | null, actorRole?: string | null, isLate: boolean, isStrike: boolean, reason?: string | null, occurredAt: string }> };

export type UpsertScheduleTemplateMutationVariables = Exact<{
  input: UpsertScheduleTemplateInput;
}>;


export type UpsertScheduleTemplateMutation = { __typename?: 'Mutation', upsertScheduleTemplate: boolean };

export type UpsertScheduleExceptionMutationVariables = Exact<{
  input: UpsertScheduleExceptionInput;
}>;


export type UpsertScheduleExceptionMutation = { __typename?: 'Mutation', upsertScheduleException: boolean };

export type ManagerReportQueryVariables = Exact<{
  fromDate?: InputMaybe<Scalars['String']['input']>;
  toDate?: InputMaybe<Scalars['String']['input']>;
}>;


export type ManagerReportQuery = { __typename?: 'Query', managerReport: { __typename?: 'Report', fromDate: string, toDate: string, totals: { __typename?: 'ReportMetrics', scheduledMinutes: number, bookedMinutes: number, loadPercent: number, completed: number, noShow: number, noShowShare: number, cancelled: number, lateCancelled: number, lateCancelShare: number, acceptedOffers: number }, doctors: Array<{ __typename?: 'DoctorReport', doctorId: number, clinicId: number, scheduledMinutes: number, bookedMinutes: number, loadPercent: number, completed: number, noShow: number, noShowShare: number, cancelled: number, lateCancelled: number, lateCancelShare: number, acceptedOffers: number }>, revenue: Array<{ __typename?: 'ServiceRevenue', serviceId: number, serviceName: string, currency: string, revenueMinor: number, appointments: number }> } };


export const CatalogDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Catalog"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clinics"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}}]}},{"kind":"Field","name":{"kind":"Name","value":"services"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"durationMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"usesUltrasoundRoom"}}]}},{"kind":"Field","name":{"kind":"Name","value":"doctors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"specialty"}}]}}]}}]} as unknown as DocumentNode<CatalogQuery, CatalogQueryVariables>;
export const MeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"patientId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}}]}}]}}]} as unknown as DocumentNode<MeQuery, MeQueryVariables>;
export const LoginDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"Login"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"email"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"password"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"login"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"email"},"value":{"kind":"Variable","name":{"kind":"Name","value":"email"}}},{"kind":"Argument","name":{"kind":"Name","value":"password"},"value":{"kind":"Variable","name":{"kind":"Name","value":"password"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"patientId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}}]}}]}}]} as unknown as DocumentNode<LoginMutation, LoginMutationVariables>;
export const RegisterDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"Register"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RegisterInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"register"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"patientId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}}]}}]}}]} as unknown as DocumentNode<RegisterMutation, RegisterMutationVariables>;
export const LogoutDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"Logout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"logout"}}]}}]} as unknown as DocumentNode<LogoutMutation, LogoutMutationVariables>;
export const FindFreeSlotsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FindFreeSlots"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"city"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"serviceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"findFreeSlots"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"city"},"value":{"kind":"Variable","name":{"kind":"Name","value":"city"}}},{"kind":"Argument","name":{"kind":"Name","value":"serviceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"serviceId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}},{"kind":"Field","name":{"kind":"Name","value":"startAt"}},{"kind":"Field","name":{"kind":"Name","value":"endAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"localTime"}},{"kind":"Field","name":{"kind":"Name","value":"utcOffsetMinutes"}}]}}]}}]} as unknown as DocumentNode<FindFreeSlotsQuery, FindFreeSlotsQueryVariables>;
export const SlotsChangedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"SlotsChanged"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"clinicId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"slotsChanged"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"clinicId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"clinicId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}}]}}]}}]} as unknown as DocumentNode<SlotsChangedSubscription, SlotsChangedSubscriptionVariables>;
export const HoldSlotDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"HoldSlot"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"HoldSlotInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"holdSlot"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"priceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"timeVersion"}},{"kind":"Field","name":{"kind":"Name","value":"holdExpiresAt"}}]}}]}}]} as unknown as DocumentNode<HoldSlotMutation, HoldSlotMutationVariables>;
export const ConfirmAppointmentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ConfirmAppointment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"idempotencyKey"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"confirmAppointment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"appointmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}}},{"kind":"Argument","name":{"kind":"Name","value":"idempotencyKey"},"value":{"kind":"Variable","name":{"kind":"Name","value":"idempotencyKey"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"priceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"timeVersion"}}]}}]}}]} as unknown as DocumentNode<ConfirmAppointmentMutation, ConfirmAppointmentMutationVariables>;
export const CancelAppointmentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CancelAppointment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"reason"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cancelAppointment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"appointmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}}},{"kind":"Argument","name":{"kind":"Name","value":"reason"},"value":{"kind":"Variable","name":{"kind":"Name","value":"reason"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<CancelAppointmentMutation, CancelAppointmentMutationVariables>;
export const RescheduleAppointmentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RescheduleAppointment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"expectedVersion"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"newStartsAt"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rescheduleAppointment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"appointmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}}},{"kind":"Argument","name":{"kind":"Name","value":"expectedVersion"},"value":{"kind":"Variable","name":{"kind":"Name","value":"expectedVersion"}}},{"kind":"Argument","name":{"kind":"Name","value":"newStartsAt"},"value":{"kind":"Variable","name":{"kind":"Name","value":"newStartsAt"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"timeVersion"}}]}}]}}]} as unknown as DocumentNode<RescheduleAppointmentMutation, RescheduleAppointmentMutationVariables>;
export const MyAppointmentsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyAppointments"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myAppointments"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"priceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"timeVersion"}},{"kind":"Field","name":{"kind":"Name","value":"holdExpiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"doctor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"specialty"}}]}},{"kind":"Field","name":{"kind":"Name","value":"clinic"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}}]}},{"kind":"Field","name":{"kind":"Name","value":"service"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"durationMinutes"}}]}}]}}]}}]} as unknown as DocumentNode<MyAppointmentsQuery, MyAppointmentsQueryVariables>;
export const StaffAppointmentsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"StaffAppointments"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"AppointmentFilter"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"appointments"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}},{"kind":"Field","name":{"kind":"Name","value":"priceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"timeVersion"}},{"kind":"Field","name":{"kind":"Name","value":"doctor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"specialty"}}]}},{"kind":"Field","name":{"kind":"Name","value":"clinic"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}}]}},{"kind":"Field","name":{"kind":"Name","value":"service"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"durationMinutes"}}]}},{"kind":"Field","name":{"kind":"Name","value":"patient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"fullName"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"phone"}}]}}]}}]}}]} as unknown as DocumentNode<StaffAppointmentsQuery, StaffAppointmentsQueryVariables>;
export const SearchPatientsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SearchPatients"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"searchPatients"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"fullName"}},{"kind":"Field","name":{"kind":"Name","value":"phone"}},{"kind":"Field","name":{"kind":"Name","value":"email"}}]}}]}}]} as unknown as DocumentNode<SearchPatientsQuery, SearchPatientsQueryVariables>;
export const ChangeAppointmentStatusDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ChangeAppointmentStatus"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"changeAppointmentStatus"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"appointmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<ChangeAppointmentStatusMutation, ChangeAppointmentStatusMutationVariables>;
export const MarkSickLeaveDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkSickLeave"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"doctorId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"clinicId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"date"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markSickLeave"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"doctorId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"doctorId"}}},{"kind":"Argument","name":{"kind":"Name","value":"clinicId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"clinicId"}}},{"kind":"Argument","name":{"kind":"Name","value":"date"},"value":{"kind":"Variable","name":{"kind":"Name","value":"date"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"applied"}},{"kind":"Field","name":{"kind":"Name","value":"cancelledAppointmentIds"}}]}}]}}]} as unknown as DocumentNode<MarkSickLeaveMutation, MarkSickLeaveMutationVariables>;
export const MyWaitlistDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyWaitlist"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myWaitlistOffers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"entryId"}},{"kind":"Field","name":{"kind":"Name","value":"appointmentId"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}},{"kind":"Field","name":{"kind":"Name","value":"serviceId"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}},{"kind":"Field","name":{"kind":"Name","value":"myWaitlistEntries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}},{"kind":"Field","name":{"kind":"Name","value":"serviceId"}},{"kind":"Field","name":{"kind":"Name","value":"dateFrom"}},{"kind":"Field","name":{"kind":"Name","value":"dateTo"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<MyWaitlistQuery, MyWaitlistQueryVariables>;
export const JoinWaitlistDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"JoinWaitlist"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"JoinWaitlistInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"joinWaitlist"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}]}]}}]} as unknown as DocumentNode<JoinWaitlistMutation, JoinWaitlistMutationVariables>;
export const LeaveWaitlistDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"LeaveWaitlist"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"entryId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"leaveWaitlist"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"entryId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"entryId"}}}]}]}}]} as unknown as DocumentNode<LeaveWaitlistMutation, LeaveWaitlistMutationVariables>;
export const AcceptOfferDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AcceptOffer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offerId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"idempotencyKey"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acceptOffer"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"offerId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offerId"}}},{"kind":"Argument","name":{"kind":"Name","value":"idempotencyKey"},"value":{"kind":"Variable","name":{"kind":"Name","value":"idempotencyKey"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"endsAt"}},{"kind":"Field","name":{"kind":"Name","value":"localDate"}}]}}]}}]} as unknown as DocumentNode<AcceptOfferMutation, AcceptOfferMutationVariables>;
export const DeclineOfferDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeclineOffer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offerId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"declineOffer"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"offerId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offerId"}}}]}]}}]} as unknown as DocumentNode<DeclineOfferMutation, DeclineOfferMutationVariables>;
export const MyRemindersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyReminders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myReminders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"appointmentId"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"doctorId"}}]}}]}}]} as unknown as DocumentNode<MyRemindersQuery, MyRemindersQueryVariables>;
export const AppointmentHistoryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AppointmentHistory"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"appointmentHistory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"appointmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"appointmentId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"appointmentId"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"fromStatus"}},{"kind":"Field","name":{"kind":"Name","value":"toStatus"}},{"kind":"Field","name":{"kind":"Name","value":"actorRole"}},{"kind":"Field","name":{"kind":"Name","value":"isLate"}},{"kind":"Field","name":{"kind":"Name","value":"isStrike"}},{"kind":"Field","name":{"kind":"Name","value":"reason"}},{"kind":"Field","name":{"kind":"Name","value":"occurredAt"}}]}}]}}]} as unknown as DocumentNode<AppointmentHistoryQuery, AppointmentHistoryQueryVariables>;
export const UpsertScheduleTemplateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpsertScheduleTemplate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpsertScheduleTemplateInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"upsertScheduleTemplate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}]}]}}]} as unknown as DocumentNode<UpsertScheduleTemplateMutation, UpsertScheduleTemplateMutationVariables>;
export const UpsertScheduleExceptionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpsertScheduleException"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpsertScheduleExceptionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"upsertScheduleException"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}]}]}}]} as unknown as DocumentNode<UpsertScheduleExceptionMutation, UpsertScheduleExceptionMutationVariables>;
export const ManagerReportDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ManagerReport"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"fromDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"toDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"managerReport"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"fromDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"fromDate"}}},{"kind":"Argument","name":{"kind":"Name","value":"toDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"toDate"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"fromDate"}},{"kind":"Field","name":{"kind":"Name","value":"toDate"}},{"kind":"Field","name":{"kind":"Name","value":"totals"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"scheduledMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"bookedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"loadPercent"}},{"kind":"Field","name":{"kind":"Name","value":"completed"}},{"kind":"Field","name":{"kind":"Name","value":"noShow"}},{"kind":"Field","name":{"kind":"Name","value":"noShowShare"}},{"kind":"Field","name":{"kind":"Name","value":"cancelled"}},{"kind":"Field","name":{"kind":"Name","value":"lateCancelled"}},{"kind":"Field","name":{"kind":"Name","value":"lateCancelShare"}},{"kind":"Field","name":{"kind":"Name","value":"acceptedOffers"}}]}},{"kind":"Field","name":{"kind":"Name","value":"doctors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"doctorId"}},{"kind":"Field","name":{"kind":"Name","value":"clinicId"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"bookedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"loadPercent"}},{"kind":"Field","name":{"kind":"Name","value":"completed"}},{"kind":"Field","name":{"kind":"Name","value":"noShow"}},{"kind":"Field","name":{"kind":"Name","value":"noShowShare"}},{"kind":"Field","name":{"kind":"Name","value":"cancelled"}},{"kind":"Field","name":{"kind":"Name","value":"lateCancelled"}},{"kind":"Field","name":{"kind":"Name","value":"lateCancelShare"}},{"kind":"Field","name":{"kind":"Name","value":"acceptedOffers"}}]}},{"kind":"Field","name":{"kind":"Name","value":"revenue"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"serviceId"}},{"kind":"Field","name":{"kind":"Name","value":"serviceName"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"revenueMinor"}},{"kind":"Field","name":{"kind":"Name","value":"appointments"}}]}}]}}]}}]} as unknown as DocumentNode<ManagerReportQuery, ManagerReportQueryVariables>;