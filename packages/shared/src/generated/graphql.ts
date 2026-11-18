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

export type Me = {
  __typename?: 'Me';
  role: Scalars['String']['output'];
  userId: Scalars['Int']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  login: Me;
  logout: Scalars['Boolean']['output'];
  register: Me;
};


export type MutationLoginArgs = {
  email: Scalars['String']['input'];
  password: Scalars['String']['input'];
};


export type MutationRegisterArgs = {
  input: RegisterInput;
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
