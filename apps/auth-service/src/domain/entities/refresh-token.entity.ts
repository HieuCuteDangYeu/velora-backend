export class RefreshToken {
  constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly token: string,
    public readonly expiresAt: Date,
    public readonly revoked: boolean,
    public readonly createdAt: Date,
    public readonly replacedByTokenId: string | null = null,
    public readonly rotationRequestId: string | null = null,
    public readonly rotatedAt: Date | null = null,
    public readonly absoluteExpiresAt: Date | null = null,
    public readonly rotationRequestExpiresAt: Date | null = null,
  ) {}

  isActive(): boolean {
    return !this.revoked && new Date() < this.expiresAt;
  }
}
