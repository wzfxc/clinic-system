/** Per-request identity: anonymous, or one of the roles the domain knows (docs/analysis/06 section 1). */
import type { AuthActor } from '@clinic/shared';

export type RequestActor = { role: 'anon' } | AuthActor | { role: 'manager'; userId: number };
