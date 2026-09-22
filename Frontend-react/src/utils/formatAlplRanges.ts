/** Compress consecutive ascending values without changing queue order or duplicates. */
export function formatAlplRanges(values: readonly number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = values[i];
    let end = start;
    while (i + 1 < values.length && values[i + 1] === end + 1) {
      end = values[++i];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}
