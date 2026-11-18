'use client';

import { useEffect } from 'react';
import { useQuery, useSubscription } from 'urql';
import { FindFreeSlotsDocument, SlotsChangedDocument } from '../graphql/generated';

/**
 * Slot grid query for a city + service that refetches (network-only) whenever
 * the API pushes slotsChanged for the given clinic. No page reload needed.
 */
export function useSlotGrid(vars: { city: string; serviceId: number; clinicId: number }) {
  const [result, reexecute] = useQuery({
    query: FindFreeSlotsDocument,
    variables: { city: vars.city, serviceId: vars.serviceId },
  });
  const [event] = useSubscription({ query: SlotsChangedDocument, variables: { clinicId: vars.clinicId } });
  const lastEvent = event.data?.slotsChanged;
  useEffect(() => {
    if (lastEvent) reexecute({ requestPolicy: 'network-only' });
  }, [lastEvent, reexecute]);
  return result;
}
