export interface ToleranceSpec {
  tolerance_id: number;
  nominal_x: number;
  nominal_y: number;
  upper_tol: number;
  lower_tol: number;
  offset_tol: number;
}

const display = (value: number) => String(Number(value.toFixed(3)));

export function toleranceLabel(t: ToleranceSpec): string {
  const xLow = display(t.nominal_x - t.lower_tol);
  const xHigh = display(t.nominal_x + t.upper_tol);
  const yLow = display(t.nominal_y - t.lower_tol);
  const yHigh = display(t.nominal_y + t.upper_tol);
  return `X=${xLow}-${xHigh}, Y=${yLow}-${yHigh}, Offset=${display(t.offset_tol)}`;
}
