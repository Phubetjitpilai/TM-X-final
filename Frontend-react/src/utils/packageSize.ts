/** Keep the dimension separator consistent with stored Package Size values. */
export function normalizePackageSize(value: string): string {
  return value.replace(/X/g, "x");
}
