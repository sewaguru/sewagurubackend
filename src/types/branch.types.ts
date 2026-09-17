export interface CreateBranchDTO {
  name: string;
  cityId: string;
  address: string;
  pincode: string;
  latitude: number;
  longitude: number;
  serviceRadiusKm?: number;
}

export interface UpdateBranchDTO {
  name?: string;
  address?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  serviceRadiusKm?: number;
  isActive?: boolean;
}