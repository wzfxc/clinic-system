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
  id: Scalars['Int']['output'];
  localDate: Scalars['String']['output'];
  patient: Patient;
  priceMinor: Scalars['Int']['output'];
  service: Service;
  startsAt: Scalars['DateTime']['output'];
  status: Scalars['String']['output'];
  timeVersion: Scalars['Int']['output'];
};

export type AppointmentFilter = {
  clinicId?: InputMaybe<Scalars['Int']['input']>;
  doctorId?: InputMaybe<Scalars['Int']['input']>;
  patientId?: InputMaybe<Scalars['Int']['input']>;
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

export type HoldSlotInput = {
  clinicId: Scalars['Int']['input'];
  doctorId: Scalars['Int']['input'];
  serviceId: Scalars['Int']['input'];
  startsAt: Scalars['DateTime']['input'];
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
  /** Places a 15-minute checkout hold for the signed-in patient. */
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
  /** Appointments visible to the actor, filtered within that scope. */
  appointments: Array<Appointment>;
  /** The signed-in account. */
  me: Me;
  /** The signed-in patient's own appointments. */
  myAppointments: Array<Appointment>;
};


export type QueryAppointmentArgs = {
  id: Scalars['Int']['input'];
};


export type QueryAppointmentsArgs = {
  filter?: InputMaybe<AppointmentFilter>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryMyAppointmentsArgs = {
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type RegisterInput = {
  email: Scalars['String']['input'];
  fullName: Scalars['String']['input'];
  password: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
};

export type Service = {
  __typename?: 'Service';
  durationMinutes: Scalars['Int']['output'];
  id: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  usesUltrasoundRoom: Scalars['Boolean']['output'];
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
