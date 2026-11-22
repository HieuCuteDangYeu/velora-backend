export interface UserResponse {
  id: string;
  email: string;
  fullName: string;
  username: string | null;
  picture: string | null;
  createdAt: Date;
  status?: 'ACTIVE' | 'BANNED';
}

export interface FindAllUsersPayload {
  page: number;
  limit: number;
  search?: string;
  sort?: 'asc' | 'desc';
}

export interface PaginatedUsersResponse {
  data: UserResponse[];
  meta: {
    total: number;
    page: number;
    limit: number;
    lastPage: number;
  };
}
