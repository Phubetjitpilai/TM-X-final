import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

// ข้อมูล dropdown ของหน้า Measure/Edit: cache ผลแต่ละ endpoint แยกกัน และตรวจ
// ข้อมูลล่าสุดเมื่อกลับเข้าหน้าอีกครั้ง เพื่อรับค่าที่อาจเพิ่งแก้ใน Lookup Tables

export interface Operator {
  operator_id: number;
  operator_name: string;
}
export interface Owner {
  owner_id: number;
  owner_name: string;
}
export interface Vendor {
  vendor_id: number;
  vendor_name: string;
}
export interface Handler {
  handler_id: number;
  handler_name: string;
}
export interface PackageSize {
  package_size_id: number;
  package_size: string;
  handlers: string[];
}

export interface PackageTolerance {
  package_size: string;
  tolerance_id: number;
  nominal_x: number;
  nominal_y: number;
  upper_tol: number;
  lower_tol: number;
  offset_tol: number;
}

export interface PartNumber {
  part_number_name: string;
  package_size: string;
  handler: string;
}

// หน้า Measure/Edit ต้องรอ lookup จนครบหลัง MySQL เริ่มทำงาน โดยแจ้งเตือนทันที
// ที่คำขอครั้งแรกพลาด แต่ไม่ทิ้งผลลัพธ์ของ endpoint อื่นที่โหลดสำเร็จแล้ว
const lookupRetry = {
  retry: true,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: true,
  networkMode: "always" as const,
};

export function useLookups() {
  const operators = useQuery({
    queryKey: ["operators"],
    queryFn: ({ signal }) => apiGet<Operator[]>("/api/operators", undefined, signal),
    ...lookupRetry,
  });
  const owners = useQuery({
    queryKey: ["owners"],
    queryFn: ({ signal }) => apiGet<Owner[]>("/api/owners", undefined, signal),
    ...lookupRetry,
  });
  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: ({ signal }) => apiGet<Vendor[]>("/api/vendors", undefined, signal),
    ...lookupRetry,
  });
  const handlers = useQuery({
    queryKey: ["handlers"],
    queryFn: ({ signal }) => apiGet<Handler[]>("/api/handlers", undefined, signal),
    ...lookupRetry,
  });
  const packageSizes = useQuery({
    queryKey: ["package-sizes"],
    queryFn: ({ signal }) => apiGet<PackageSize[]>("/api/package-sizes", undefined, signal),
    ...lookupRetry,
  });
  const tolerances = useQuery({
    queryKey: ["package-size-tolerances"],
    queryFn: ({ signal }) => apiGet<PackageTolerance[]>("/api/package-size-tolerances", undefined, signal),
    ...lookupRetry,
  });
  const partNumbers = useQuery({
    queryKey: ["part-numbers-all"],
    queryFn: ({ signal }) => apiGet<PartNumber[]>("/api/part-numbers/all", undefined, signal),
    ...lookupRetry,
  });

  const queries = [operators, owners, vendors, handlers, packageSizes, tolerances, partNumbers];

  return {
    operators: operators.data ?? [],
    owners: owners.data ?? [],
    vendors: vendors.data ?? [],
    handlers: handlers.data ?? [],
    packageSizes: packageSizes.data ?? [],
    tolerances: tolerances.data ?? [],
    partNumbers: partNumbers.data ?? [],
    partNumbersLoaded: partNumbers.data !== undefined,
    isLoading: queries.some((query) => query.isPending),
    isFailed: queries.some((query) => query.failureCount > 0 || query.isError),
    hasAllLoadedData: queries.every((query) => query.data !== undefined),
  };
}
