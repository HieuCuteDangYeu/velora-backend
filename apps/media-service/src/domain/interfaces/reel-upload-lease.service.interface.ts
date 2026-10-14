export interface ReelUploadLeaseReservation {
  userId: string;
  publishIntentId: string;
  mediaKey: string;
  fileType: string;
  expiresAt: Date;
}

export interface IReelUploadLeaseService {
  reserve(input: ReelUploadLeaseReservation): Promise<void>;
}
