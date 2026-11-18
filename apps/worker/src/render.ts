import { localSlotInfo, SICK_LEAVE_TEMPLATE } from '@clinic/shared';

export interface RenderedMail {
  subject: string;
  text: string;
}

type Payload = Readonly<Record<string, unknown>>;

const str = (payload: Payload, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`mail payload has no "${key}"`);
  return value;
};

/** Visit time in the clinic zone, so the text stays right across DST changes. */
function visitTime(payload: Payload): string {
  const info = localSlotInfo(new Date(str(payload, 'startsAt')), str(payload, 'timezone'));
  return `${info.localDate} ${info.localTime}`;
}

/** Pure. An unknown template or a malformed payload throws, so the row fails loudly instead of sending junk. */
export function renderMail(template: string, payload: Payload): RenderedMail {
  switch (template) {
    case 'reminder_h24':
      return {
        subject: 'Нагадування: візит завтра',
        text: `Нагадуємо про візит до клініки: ${visitTime(payload)}.`,
      };
    case 'reminder_h2':
      return {
        subject: 'Нагадування: візит за 2 години',
        text: `Ваш візит до клініки розпочнеться о ${visitTime(payload)}.`,
      };
    case SICK_LEAVE_TEMPLATE:
      return {
        subject: 'Ваш запис скасовано',
        text: `Лікар не зможе прийняти вас ${str(payload, 'date')}, запис скасовано. Будь ласка, оберіть інший час.`,
      };
    default:
      throw new Error(`unknown mail template "${template}"`);
  }
}
