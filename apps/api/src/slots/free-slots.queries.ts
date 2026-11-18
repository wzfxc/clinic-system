import type { Pool } from 'pg';
import { loadFreeSlots, type Clock, type FreeSlot } from '@clinic/shared';

export interface CityFreeSlot extends FreeSlot {
  clinicId: number;
}

/** Free slots of one service across all clinics in a city (every doctor of those clinics who offers it), 14 days. */
export async function findCityFreeSlots(
  pool: Pool,
  clock: Clock,
  city: string,
  serviceId: number,
): Promise<CityFreeSlot[]> {
  const clinics = await pool.query<{ id: string }>(
    `SELECT c.id FROM clinics c JOIN clinic_services cs ON cs.clinic_id = c.id AND cs.service_id = $2
      WHERE c.city = $1 ORDER BY c.id`,
    [city, serviceId],
  );
  const client = await pool.connect();
  try {
    const result: CityFreeSlot[] = [];
    for (const row of clinics.rows) {
      const clinicId = Number(row.id);
      const slots = await loadFreeSlots(client, clock, { clinicId, serviceId });
      result.push(...slots.map((s) => ({ ...s, clinicId })));
    }
    return result.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.doctorId - b.doctorId);
  } finally {
    client.release();
  }
}
