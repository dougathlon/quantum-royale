export function summarizeEventIds(
  ids: readonly number[],
  visibleLimit = 8,
): string {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return "none";

  const visible = uniqueIds
    .slice(0, visibleLimit)
    .map((id) => `#${id}`)
    .join(", ");
  const hiddenCount = uniqueIds.length - visibleLimit;
  return hiddenCount > 0 ? `${visible} +${hiddenCount} more` : visible;
}
