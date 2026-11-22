export interface BanUserPayload {
  id: string;
  bannedBy: string;
  reason: string;
}

export interface UnbanUserPayload {
  id: string;
}

export interface BanUserResponse {
  id: string;
  status: 'ACTIVE' | 'BANNED';
  message: string;
}
