export class User {
  constructor(
    public readonly id: string | null,
    public readonly email: string,
    public readonly fullName: string,
    public readonly username: string | null,
    public readonly password: string | null,
    public readonly isVerified: boolean,
    public readonly createdAt: Date | null,
    public readonly picture: string | null,
    public readonly provider: string | null,
    public readonly providerId: string | null,
    public readonly status: 'ACTIVE' | 'BANNED' = 'ACTIVE',
    public readonly bannedAt: Date | null = null,
    public readonly banReason: string | null = null,
  ) {}
}
