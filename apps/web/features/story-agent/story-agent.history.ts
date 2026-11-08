// The confirmation and post-delete refresh are one testable interaction boundary.
export const deleteConfirmedHistoryEntry = async (input: Readonly<{
  confirmed: boolean;
  runId: string;
  deleteRun: (runId: string) => Promise<void>;
  onDeleted: (runId: string) => void;
  refresh: () => Promise<void>;
}>): Promise<boolean> => {
  if (!input.confirmed) return false;
  await input.deleteRun(input.runId);
  input.onDeleted(input.runId);
  await input.refresh();
  return true;
};
