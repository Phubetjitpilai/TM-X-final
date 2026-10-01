import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

// useLookups: ดึง dropdown data (operators/owners/vendors/handlers/package-sizes)
// ครั้งเดียว ใช้ร่วมกันได้ทุกหน้า (Dashboard/Edit) — แก้ปัญหาที่ index.html และ
// edit.html เดิมต่างคน copy fetch ชุดนี้แยกกันคนละชุด (ดู CLAUDE.md หัวข้อ
// Frontend Framework Migration) TanStack Query จะ cache ผลลัพธ์ไว้ให้เอง ครั้ง
// ต่อไปที่ component ไหนเรียก useLookups() จะไม่ยิง fetch ซ้ำถ้าข้อมูลยัง fresh อยู่

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

export function useLookups() {
  const operators = useQuery({
    queryKey: ["operators"],
    queryFn: () => apiGet<Operator[]>("/api/operators"),
  });
  const owners = useQuery({
    queryKey: ["owners"],
    queryFn: () => apiGet<Owner[]>("/api/owners"),
  });
  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: () => apiGet<Vendor[]>("/api/vendors"),
  });
  const handlers = useQuery({
    queryKey: ["handlers"],
    queryFn: () => apiGet<Handler[]>("/api/handlers"),
  });
  const packageSizes = useQuery({
    queryKey: ["package-sizes"],
    queryFn: () => apiGet<PackageSize[]>("/api/package-sizes"),
  });

  return {
    operators: operators.data ?? [],
    owners: owners.data ?? [],
    vendors: vendors.data ?? [],
    handlers: handlers.data ?? [],
    packageSizes: packageSizes.data ?? [],
    isLoading:
      operators.isLoading ||
      owners.isLoading ||
      vendors.isLoading ||
      handlers.isLoading ||
      packageSizes.isLoading,
  };
}
