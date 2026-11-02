/**
 * What stays queued on Open Tasks after a submit that did not come back
 * cleanly. Pure so it can be tested.
 *
 * - Signed out: the request never reached Salesforce, so every unsent action is kept.
 * - Task list could not be reloaded: we can't tell, so every unsent action is kept.
 * - Otherwise an action is kept only while its task is still open on the same
 *   due date, so one that already ran is never applied twice.
 */
export type QueuedAction = { taskId: string; currentDate: string };

export function keepAfterFailure<T extends QueuedAction>(
  unsent: T[],
  fresh: Array<{ Id: string; ActivityDate: string | null }> | null,
  signedOut: boolean,
): T[] {
  if (signedOut || !fresh) return unsent;
  const open = new Map(fresh.map((t) => [t.Id, t.ActivityDate]));
  return unsent.filter((a) => open.get(a.taskId) === a.currentDate);
}
