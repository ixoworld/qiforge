export type CurrentToolAvailability = (
  pluginName: string,
) => Promise<ReadonlySet<string> | undefined>;

export async function readCurrentToolAvailability(
  callback: CurrentToolAvailability | undefined,
  pluginName: string,
): Promise<ReadonlySet<string> | undefined> {
  if (!callback) return undefined;
  try {
    return await callback(pluginName);
  } catch {
    return new Set<string>();
  }
}
