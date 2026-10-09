/** Convert backend-facing legacy terms to the current UI terminology. */
export function toUiTerms(input: string): string {
  const catalogPart = "__CATALOG_PART_TERM__";
  return input
    .replace(/ALPL#/g, "DWG#")
    .replace(/Part Number/g, catalogPart)
    .replace(/Package Size/g, "Opening")
    .replace(/ALPL/g, "Part Number")
    .replace(new RegExp(catalogPart, "g"), "DWG#")
    .replace(/Nominal X/g, "Nominal_X")
    .replace(/Nominal Y/g, "Nominal_Y")
    .replace(/Upper Tolerance|Upper Tol/g, "USL")
    .replace(/Lower Tolerance|Lower Tol/g, "LSL")
    .replace(/Offset Tolerance|Offset Tol/g, "Centering Offset")
    .replace(/Value X/g, "Measuring_X")
    .replace(/Value Y/g, "Measuring_Y")
    .replace(/Offset Position/g, "Opening shift")
    .replace(/Offset X/g, "Offset_X")
    .replace(/Offset Y/g, "Offset_Y")
    .replace(/PO Number|PO number/g, "PO#")
    .replace(/Description/g, "Desc.")
    .replace(/Operator/g, "Performed by")
    .replace(/Owner/g, "Order by")
    .replace(/Handler/g, "H/L")
    .replace(/Measure Date/g, "Performed date");
}
